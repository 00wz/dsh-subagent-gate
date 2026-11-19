/**
 * dsh-subagent-gate — host half.
 *
 * Purpose: a delegated child is pinned by DSH to `approval: "never"`, so every
 * escalation it makes is rejected before anyone is asked. This plugin re-arms
 * exactly that one knob to `ask` for children whose subtree still has a human in
 * the loop, and answers the resulting approval request by asking the person
 * (directly in the child's session when the client supports it, otherwise
 * forwarded to the root session).
 *
 * Design constraints, on purpose:
 *  - host-only: no client bundle, no UI strings, no remote methods;
 *  - never touches the sandbox mode or the permission preset table;
 *  - every decision goes through `Pipeline`, so future stages (rules, denylist,
 *    judge, autoapprove) are added without touching this file;
 *  - anything unexpected fails closed (`rejected`), never "allow".
 */
import { Service } from "@deepseek-ai/cordis";
import { scopeTarget } from "@deepseek-ai/dsh-scope";
import { HumanGate } from "./ask.js";
import { Audit } from "./audit.js";
import { DEFAULTS, CONFIG_FILE, loadConfig, saveConfig } from "./config.js";
import { Coverage } from "./coverage.js";
import { Knobs } from "./knobs.js";
import { Pipeline } from "./pipeline.js";
import { createGatePrompt } from "./prompt.js";
import { Queue } from "./queue.js";
import { TargetRegistry } from "./targets.js";

/** `allow` is the only verdict that lets the call through. */
const OUTCOME_ALLOW = "allowed-once";
const OUTCOME_DENY = "rejected";

export class SubagentGate extends Service {
  /** Hard dependencies: without them nothing can be decided or routed. */
  static inject = ["approval", "agents"];

  constructor(ctx, config) {
    super(ctx, "subagentGate");
    this.config = { ...DEFAULTS };
    /** session ids this gate armed (children it set to `ask`). */
    this.armed = new Set();
    this.presentations = new WeakSet();
    this.lifetime = new AbortController();
  }

  async [Service.init]() {
    this.config = await loadConfig();
    this.ctx.effect(() => () => {
      this.lifetime.abort();
      this.#restoreArmed();
    });

    this.audit = new Audit(this.config);
    this.coverage = new Coverage({ agents: this.ctx.agents, approval: this.ctx.approval });
    this.knobs = new Knobs(this.ctx.approval);
    this.queue = new Queue();
    /**
     * Where a confirmation is shown. `registerTarget(id, resolve)` is a public
     * extension point: another plugin can add a transport (modal, notification,
     * webhook, dedicated approvals session) without touching this file.
     */
    this.targets = new TargetRegistry();
    this.gate = new HumanGate({
      approval: this.ctx.approval,
      coverage: this.coverage,
      config: this.config,
      queue: this.queue,
      audit: this.audit,
      targets: this.targets,
      isLive: (agent) => this.ctx.agents.get(agent.session.id) === agent,
      present: async (request) => {
        // This is presentation inside the child's existing approval/request.
        // No second approval.request() and no synthetic root turn/audit pair.
        this.presentations.add(request);
        try {
          return await this.ctx.waterfall(
            scopeTarget(request.agent, request.agent),
            "approval/request", request, () => Promise.resolve("unavailable"),
          );
        } finally {
          this.presentations.delete(request);
        }
      },
    });
    this.pipeline = new Pipeline([this.gate.stage()]);

    // Arm children as they are created. `agent/created` fires after the
    // permission service has already written the delegation knobs, so the flip
    // is the last word on the child's policy.
    this.ctx.on("agent/created", (payload) => {
      void this.#onCreated(payload);
    });

    this.ctx.on("session/disposed", (session) => {
      try {
        if (!session) return;
        this.coverage.forget(session.id);
        this.knobs.forget(session.id);
        this.armed.delete(session.id);
      } catch {
        /* bookkeeping only */
      }
    });

    // Prepend: the gate must win over the interactive answerer for managed
    // children, and stay invisible to everyone else.
    this.ctx.on("approval/request", (req, next) => this.#onApproval(req, next), { prepend: true });

    // Best effort: children that already exist when the plugin loads.
    void this.#armExisting();

    // Tell armed children the truth about who decides — the host's delegation
    // note says the opposite, and a model that believes it never asks at all.
    this.ctx.inject(["systemPrompt"], (scope) => {
      scope.systemPrompt.context(
        createGatePrompt({
          coverage: this.coverage, isChild: Coverage.isChild,
          enabled: () => this.config.enabled,
          order: scope.systemPrompt.getContextOrder("SUBAGENT_DELEGATION") + 1,
          suffix: this.config.promptSuffix,
        }),
      );
    });

    this.ctx.inject(["commands"], (scope) => this.#registerCommand(scope));
  }

  // ---- listeners -----------------------------------------------------------

  async #onCreated(payload) {
    if (!this.config.enabled) return;
    try {
      const agent = payload && payload.agent;
      const session = agent && agent.session;
      if (!session || !Coverage.isChild(session)) return;
      if (!this.coverage.isManaged(session)) return;
      this.knobs.arm(agent);
      this.armed.add(session.id);
      await this.audit.record({
        kind: "arm",
        sessionId: session.id,
        depth: session.header?.delegationDepth ?? 0,
        policy: "ask",
      });
    } catch {
      /* a listener must never throw into the host */
    }
  }

  /**
   * The approval waterfall listener.
   * Claims managed children only; everything else gets `next()` untouched.
   */
  async #onApproval(req, next) {
    if (!this.config.enabled || this.presentations.has(req)) return next();
    let ctx;
    try {
      const agent = req && req.agent;
      const session = agent && agent.session;
      if (!session || !Coverage.isChild(session)) return await next();
      if (this.gate === undefined) return await next();
      if (!this.coverage.isManaged(session)) return await next();
      ctx = {
        agent,
        session,
        toolName: req.toolName,
        callId: req.callId,
        reason: req.reason,
        signal: req.signal ? AbortSignal.any([req.signal, this.lifetime.signal]) : this.lifetime.signal,
        depth: Number.isFinite(session.header?.delegationDepth) ? session.header.delegationDepth : this.coverage.ancestors(session).length,
        signals: [],
      };
    } catch {
      return await next();
    }

    try {
      const verdict = await this.pipeline.run(ctx);
      return verdict.decision === "allow" && ctx.grantIsCurrent?.() === true ? OUTCOME_ALLOW : OUTCOME_DENY;
    } catch {
      // Fail closed: a broken decision must never widen a child's reach.
      return OUTCOME_DENY;
    }
  }

  // ---- helpers -------------------------------------------------------------

  /**
   * Public extension point: register a confirmation transport.
   * @param {string} id  config value for `forwardTo`
   * @param {(ctx: object, gate: object) => {agent: object, path: string, probe?: boolean}} resolve
   */
  registerTarget(id, resolve) {
    this.targets.register(id, resolve);
    return this;
  }

  #restoreArmed() {
    for (const id of this.armed) {
      try {
        const agent = this.ctx.agents.get(id);
        if (agent) this.knobs?.restore(agent);
      } catch { /* a leaving agent must not break teardown */ }
    }
    this.armed.clear();
  }

  async #armExisting() {
    if (!this.config.enabled) return;
    try {
      const agents = this.ctx.agents;
      if (typeof agents.list !== "function") return;
      for (const agent of agents.list()) {
        const session = agent && agent.session;
        if (!session || !Coverage.isChild(session)) continue;
        if (!this.coverage.isManaged(session)) continue;
        this.knobs.arm(agent);
        this.armed.add(session.id);
      }
    } catch {
      /* best effort only */
    }
  }

  #registerCommand(scope) {
    scope.commands.register({
      name: "subagent-gate",
      description: "Subagent escalation gate: ask the human before a delegated child widens its sandbox",
      input: { hint: "<status|on|off>" },
      handler: (invocation) => {
        const arg = String(invocation?.rawInput ?? "").trim().toLowerCase();
        if (arg === "off") {
          this.config.enabled = false;
          void saveConfig(this.config);
          this.lifetime.abort();
          this.#restoreArmed();
          return { kind: "success", text: "subagent-gate: OFF (armed children restored to their previous policy)" };
        }
        if (arg === "on") {
          this.config.enabled = true;
          if (this.lifetime.signal.aborted) this.lifetime = new AbortController();
          void saveConfig(this.config);
          void this.#armExisting();
          return { kind: "success", text: "subagent-gate: ON" };
        }
        const capability = this.gate?.capability ?? "unknown (not probed)";
        const configured = this.config.forwardTo;
        const known = this.targets ? this.targets.has(configured) : false;
        return {
          kind: "success",
          text: [
            `subagent-gate: ${this.config.enabled ? "ON" : "OFF"}`,
            `forwardTo: ${configured}${known ? "" : " (NOT REGISTERED — falls back to root)"} (resolved: ${capability})`,
            `targets: ${this.targets ? this.targets.ids().join(", ") : "-"}`,
            `humanTimeoutMs: ${this.config.humanTimeoutMs === 0 ? "unlimited" : this.config.humanTimeoutMs}`,
            `directProbeMs: ${this.config.directProbeMs}`,
            `armed children: ${this.armed.size}`,
            `config: ${CONFIG_FILE}`,
          ].join("\n"),
        };
      },
    });
  }
}

export default SubagentGate;
