/**
 * dsh-subagent-gate — the `human` stage.
 *
 * Turns a child's escalation into a person's decision. Two delivery paths:
 *
 *   self  — re-ask in the child's own session and let the stock UI answerer
 *           show the card (used when the Web UI renders child sessions)
 *   root  — re-ask in the nearest non-subagent ancestor: the session the user
 *           is looking at, which is guaranteed to show the card
 *
 * `forwardTo: "auto"` starts with `self`, probes it once per host run with a
 * short budget, and permanently falls back to `root` if that probe goes
 * unanswered (i.e. the client does not render child cards). The capability is
 * cached, so at most one probe is ever spent per process.
 *
 * Nothing here grants more than the person did: a `self`/`root` answer of
 * `allowed-once` maps to one allow for that one call, everything else
 * (rejection, cancellation, timeout, no answerer) is fail-closed.
 */

const OUTCOME_TO_DECISION = {
  "allowed-once": "allow",
  rejected: "deny",
  cancelled: "deny",
  unavailable: "deny",
};

/** First 8 chars of the UUID part of a session id, for the provenance line. */
export function shortId(id) {
  const text = String(id ?? "");
  const tail = text.startsWith("session-") ? text.slice("session-".length) : text;
  return tail.slice(0, 8);
}

export class HumanGate {
  /**
   * @param {object} deps
   * @param {object} deps.approval  ctx.approval (request / setPolicy / overrideOf)
   * @param {object} deps.coverage  Coverage instance
   * @param {object} deps.config    normalized config
   * @param {object} deps.queue     Queue instance
   * @param {object} deps.audit     Audit instance
   */
  constructor(deps) {
    this.approval = deps.approval;
    this.coverage = deps.coverage;
    this.config = deps.config;
    this.queue = deps.queue;
    this.audit = deps.audit;
    /** TargetRegistry: where a card is shown (extension point). */
    this.targets = deps.targets;
    /** "self" | "root" | undefined (unknown, probe on first use). */
    this.capability = undefined;
    /** session ids with an ask of our own in flight — the listener skips these. */
    this.busy = new Set();
  }

  /** The pipeline stage face. */
  stage() {
    return {
      id: "human",
      order: 100,
      failClosed: true,
      decide: (ctx) => this.decide(ctx),
    };
  }

  /** True while this session's request came from the gate itself (no re-claim). */
  isBusy(sessionId) {
    return this.busy.has(sessionId);
  }

  async decide(ctx) {
    const startedAt = Date.now();
    let target = this.targets.resolve(this.config.forwardTo, ctx, this);
    let result = undefined;

    if (target.probe === true) {
      const probe = await this.#ask(ctx, ctx.agent, this.config.directProbeMs, ctx.signal);
      if (probe.kind === "decided") {
        this.capability = "self";
        result = { path: "self", ...probe };
      } else {
        // The target did not surface an answerable card; remember that and
        // re-resolve (an `auto` strategy now yields the root session).
        this.capability = "root";
        target = this.targets.resolve(this.config.forwardTo, ctx, this);
      }
    }

    if (result === undefined) {
      if (!target.agent || !target.agent.session) {
        result = { path: target.path ?? "root", kind: "no-answerer" };
      } else {
        result = { path: target.path ?? "root", ...(await this.queue.run(() => this.#ask(ctx, target.agent, this.config.humanTimeoutMs, ctx.signal))) };
      }
    }

    const decision = this.#toDecision(result);
    await this.audit.record({
      kind: "human",
      sessionId: ctx.session.id,
      depth: ctx.depth ?? 0,
      toolName: ctx.toolName,
      path: result.path,
      outcome: result.outcome ?? result.kind ?? "?",
      decision,
      durationMs: Date.now() - startedAt,
      reason: typeof ctx.reason === "string" ? ctx.reason.slice(0, 400) : "",
    });
    return { decision, final: true };
  }

  #toDecision(result) {
    if (result.outcome !== undefined) return OUTCOME_TO_DECISION[result.outcome] ?? "deny";
    if (result.kind === "timeout") return this.config.onTimeout === "allow" ? "allow" : "deny";
    return this.config.onNoAnswerer === "allow" ? "allow" : "deny";
  }

  /**
   * Issue one approval request and wait for it.
   * @returns {Promise<{kind: "decided", outcome: string} | {kind: "timeout"} | {kind: "error", error: unknown}>}
   */
  async #ask(ctx, agent, timeoutMs, outerSignal) {
    if (!agent || !agent.session) return { kind: "error", error: new Error("no agent") };
    const marks = [ctx.session && ctx.session.id, agent.session.id].filter((id) => typeof id === "string");
    for (const id of marks) this.busy.add(id);
    try {
      const controller = typeof AbortController === "function" ? new AbortController() : undefined;
      const signal = this.#combineSignals(outerSignal, controller && controller.signal);
      const request = {
        agent,
        toolName: String(ctx.toolName ?? "tool"),
        ...(ctx.callId ? { callId: ctx.callId } : {}),
        ...(this.config.provenance ? { reason: this.#reason(ctx) } : ctx.reason ? { reason: String(ctx.reason) } : {}),
        ...(this.config.provenance ? { displayReason: this.#display(ctx) } : {}),
        ...(signal ? { signal } : {}),
      };
      const outcome = await this.#withTimeout(
        () => this.approval.request(request),
        timeoutMs,
        controller,
      );
      if (outcome === TIMEOUT) return { kind: "timeout" };
      return { kind: "decided", outcome: String(outcome) };
    } catch (error) {
      return { kind: "error", error };
    } finally {
      for (const id of marks) this.busy.delete(id);
    }
  }

  /** `[subagent 1a800884 · depth 1] pwsh: <the child's own justification>` */
  #reason(ctx) {
    const bits = [];
    if (ctx.depth >= 0) bits.push(`[subagent ${shortId(ctx.session.id)}${ctx.depth > 0 ? ` · depth ${ctx.depth}` : ""}]`);
    bits.push(String(ctx.toolName ?? "tool"));
    const stated = typeof ctx.reason === "string" && ctx.reason.trim() !== "" ? ctx.reason.trim() : "";
    if (stated !== "") bits.push(stated);
    return bits.join(" ");
  }

  /** A short line for the card header. */
  #display(ctx) {
    const stated = typeof ctx.reason === "string" && ctx.reason.trim() !== "" ? ctx.reason.trim() : "no justification given";
    return `Subagent ${shortId(ctx.session.id)} asks: ${stated}`;
  }

  #combineSignals(a, b) {
    if (a && b && typeof AbortSignal !== "undefined" && typeof AbortSignal.any === "function") {
      return AbortSignal.any([a, b]);
    }
    return b ?? a;
  }

  /** Resolve with TIMEOUT after `timeoutMs`; 0/null means "wait forever". */
  #withTimeout(start, timeoutMs, controller) {
    const promise = Promise.resolve().then(start);
    if (!timeoutMs || timeoutMs <= 0) return promise;
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          if (controller && typeof controller.abort === "function") controller.abort();
        } catch {
          /* ignore */
        }
        resolve(TIMEOUT);
      }, timeoutMs);
      promise.then(
        (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }
}

const TIMEOUT = Symbol("timeout");
