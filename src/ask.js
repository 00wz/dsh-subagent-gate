/**
 * The human stage routes presentation, not a second approval transaction.
 * The original child's approval.request() owns its turn-enclosed audit pair.
 * `present` dispatches the answerer waterfall in the selected Agent scope,
 * including an idle root, without calling approval.request() on that root.
 */
const OUTCOME_TO_DECISION = {
  "allowed-once": "allow",
  rejected: "deny",
  cancelled: "deny",
  unavailable: "deny",
};
const TIMEOUT = Symbol("timeout");
const CANCELLED = Symbol("cancelled");

export function shortId(id) {
  const text = String(id ?? "");
  return (text.startsWith("session-") ? text.slice("session-".length) : text).slice(0, 8);
}

export class HumanGate {
  constructor(deps) {
    this.approval = deps.approval;
    this.coverage = deps.coverage;
    this.config = deps.config;
    this.queue = deps.queue;
    this.audit = deps.audit;
    this.targets = deps.targets;
    this.present = deps.present;
    this.isLive = deps.isLive ?? (() => true);
    this.capability = undefined;
    // Diagnostic only. Recursion is suppressed by exact request identity in
    // the Host transport, never by skipping every request from a busy session.
    this.busy = new Set();
  }

  stage() {
    return { id: "human", order: 100, failClosed: true, decide: (ctx) => this.decide(ctx) };
  }

  isBusy(sessionId) { return this.busy.has(sessionId); }

  async decide(ctx) {
    const startedAt = Date.now();
    let result;
    try {
      // The probe shares the FIFO too: concurrent first asks cannot show
      // multiple cards. A cancelled queued ask never starts presentation.
      result = await this.queue.run(async () => {
        if (ctx.signal?.aborted) return { path: "none", outcome: "cancelled" };
        let target = this.targets.resolve(this.config.forwardTo, ctx, this);
        if (target.probe === true) {
          const probe = await this.#ask(ctx, ctx.agent, this.config.directProbeMs, ctx.signal);
          if (probe.outcome === "allowed-once" || probe.outcome === "rejected") {
            this.capability = "self";
            return { path: "self", targetAgent: ctx.agent, ...probe };
          }
          if (ctx.signal?.aborted || probe.outcome === "cancelled") {
            return { path: "self", outcome: "cancelled" };
          }
          // Unavailable, error or timeout is not evidence of a working self UI.
          this.capability = "root";
          target = this.targets.resolve(this.config.forwardTo, ctx, this);
        }
        if (!target.agent?.session) return { path: target.path ?? "root", kind: "no-answerer" };
        return { path: target.path ?? "root", targetAgent: target.agent, ...(await this.#ask(ctx, target.agent, this.config.humanTimeoutMs, ctx.signal)) };
      }, ctx.signal);
    } catch {
      result = { path: "none", kind: ctx.signal?.aborted ? "cancelled" : "error" };
    }
    // Only an explicit, still-current allowed-once can permit a call. Config
    // cannot turn missing answerers, cancellation, timeouts or errors into grants.
    const decision = ctx.signal?.aborted ? "deny" : OUTCOME_TO_DECISION[result.outcome] ?? "deny";
    // Retain the selected target through the async journal and pipeline. The
    // Host listener rechecks this again at its final synchronous grant boundary.
    const grantIsCurrent = () => !ctx.signal?.aborted && this.#allows(ctx.agent) && this.#allows(result.targetAgent);
    ctx.grantIsCurrent = grantIsCurrent;
    await this.audit.record({
      kind: "human", sessionId: ctx.session.id, depth: ctx.depth ?? 0,
      toolName: ctx.toolName, path: result.path,
      outcome: result.outcome ?? result.kind ?? "error", decision,
      durationMs: Date.now() - startedAt,
      reason: typeof ctx.reason === "string" ? ctx.reason.slice(0, 400) : "",
    });
    if (decision === "allow" && !grantIsCurrent()) {
      await this.audit.record({
        kind: "invalidated", sessionId: ctx.session.id, toolName: ctx.toolName,
        path: result.path, outcome: "rejected", decision: "deny",
      });
      return { decision: "deny", final: true };
    }
    return { decision, final: true };
  }

  #allows(agent) {
    try {
      return this.config.enabled !== false && agent?.session && this.isLive(agent)
        && (this.approval.overrideOf(agent.session) ?? this.approval.config?.policy ?? "ask") === "ask";
    } catch {
      return false;
    }
  }

  async #ask(ctx, agent, timeoutMs, outerSignal) {
    if (outerSignal?.aborted) return { outcome: "cancelled" };
    if (!this.#allows(ctx.agent) || !this.#allows(agent)) return { outcome: "rejected" };
    if (typeof this.present !== "function") return { kind: "no-answerer" };
    const marks = [...new Set([ctx.session.id, agent.session.id])];
    marks.forEach(id => this.busy.add(id));
    try {
      const controller = new AbortController();
      const signal = outerSignal ? AbortSignal.any([outerSignal, controller.signal]) : controller.signal;
      const sameSession = agent === ctx.agent;
      const request = {
        agent,
        toolName: String(ctx.toolName ?? "tool"),
        // A tool call id belongs to its source session. Forwarded cards must
        // not try to resolve the child's tool details inside the root session.
        ...(sameSession && ctx.callId ? { callId: ctx.callId } : {}),
        ...(this.config.provenance ? { reason: this.#reason(ctx) } : ctx.reason ? { reason: String(ctx.reason) } : {}),
        ...(this.config.provenance ? { displayReason: { en: this.#display(ctx) } } : {}),
        signal,
      };
      const outcome = await this.#withTimeout(() => {
        // Check again after the promise boundary and immediately before I/O.
        if (!this.#allows(ctx.agent) || !this.#allows(agent)) return "rejected";
        return this.present(request);
      }, timeoutMs, controller, signal);
      if (outcome === TIMEOUT) return { kind: "timeout" };
      if (outcome === CANCELLED || outerSignal?.aborted) return { outcome: "cancelled" };
      if (!this.#allows(ctx.agent) || !this.#allows(agent)) return { outcome: "rejected" };
      return { outcome: typeof outcome === "string" && Object.hasOwn(OUTCOME_TO_DECISION, outcome) ? outcome : "unavailable" };
    } catch {
      return { kind: "error" };
    } finally {
      marks.forEach(id => this.busy.delete(id));
    }
  }

  #reason(ctx) {
    const bits = [`[subagent ${shortId(ctx.session.id)}${ctx.depth > 0 ? ` · depth ${ctx.depth}` : ""}]`, String(ctx.toolName ?? "tool")];
    if (typeof ctx.reason === "string" && ctx.reason.trim() !== "") bits.push(ctx.reason.trim());
    return bits.join(" ");
  }

  #display(ctx) {
    const stated = typeof ctx.reason === "string" && ctx.reason.trim() !== "" ? ctx.reason.trim() : "no justification given";
    return `Subagent ${shortId(ctx.session.id)} asks: ${stated}`;
  }

  #withTimeout(start, timeoutMs, controller, signal) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer;
      const finish = (value, error = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        if (error) reject(value); else resolve(value);
      };
      const onAbort = () => finish(CANCELLED);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) { finish(CANCELLED); return; }
      if (timeoutMs > 0) timer = setTimeout(() => {
        finish(TIMEOUT);
        controller.abort();
      }, timeoutMs);
      Promise.resolve().then(() => signal.aborted ? CANCELLED : start()).then(
        value => finish(value), error => finish(error, true),
      );
    });
  }
}
