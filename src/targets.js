/**
 * dsh-subagent-gate — where a confirmation is shown.
 *
 * A target strategy answers one question: *which agent should carry this
 * approval request?* It is the plugin's single extension point for the UX of
 * confirmation, so future transports (a modal, a notification, a webhook, a
 * separate "approvals" session) are added by registering a strategy — the gate
 * itself does not change.
 *
 * A strategy receives `(ctx, gate)` and returns:
 *   { agent, path, probe? }
 *   agent — the agent whose session should show the card
 *   path  — a stable label for the audit trail
 *   probe — true to spend a short, one-time budget on this target and fall
 *           back to `root` if it is not answered (see `auto`)
 */

/** Built-in strategies; `root` is the default for a reason (see README). */
export const BUILTIN_TARGETS = {
  /** The nearest non-subagent ancestor: the session the user is looking at. */
  root: (ctx, gate) => {
    const agent = gate.coverage.rootAgent(ctx.session);
    return agent ? { agent, path: "root" } : { agent: ctx.agent, path: "self" };
  },

  /** The child's own session. Visible only when that session is open. */
  self: (ctx) => ({ agent: ctx.agent, path: "self" }),

  /**
   * Probe `self` once per process, then stay on the winner. Useful when the
   * client does render child-session cards; costs one `directProbeMs` delay on
   * the very first ask otherwise.
   */
  auto: (ctx, gate) => {
    if (gate.capability === "root") return BUILTIN_TARGETS.root(ctx, gate);
    if (gate.capability === "self") return BUILTIN_TARGETS.self(ctx);
    if (gate.config.directProbeMs > 0) return { agent: ctx.agent, path: "self", probe: true };
    return BUILTIN_TARGETS.root(ctx, gate);
  },
};

export class TargetRegistry {
  constructor(initial = BUILTIN_TARGETS) {
    this.map = new Map(Object.entries(initial));
  }

  /** Add or replace a strategy. Returns this, so registration chains. */
  register(id, resolve) {
    if (typeof id !== "string" || id === "" || typeof resolve !== "function") return this;
    this.map.set(id, resolve);
    return this;
  }

  has(id) {
    return this.map.has(id);
  }

  ids() {
    return [...this.map.keys()];
  }

  /**
   * Resolve `id` to a target. An unknown id (config from a newer version, or a
   * strategy whose plugin is not loaded) falls back to `root` — never to
   * "nobody", because a confirmation that goes nowhere would hang a child.
   */
  resolve(id, ctx, gate) {
    const fallback = this.map.get("root");
    const chosen = this.map.get(id) ?? fallback;
    try {
      const target = chosen(ctx, gate);
      if (target && target.agent) return target;
    } catch {
      /* fall through to the fallback */
    }
    return fallback(ctx, gate);
  }
}
