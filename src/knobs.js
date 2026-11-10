/**
 * dsh-subagent-gate — approval-knob bookkeeping.
 *
 * A delegated child is pinned to `never` by the host (see
 * `captureDelegatedPolicyOverrides` in dsh-subagent). The gate re-arms exactly
 * that one knob to `ask` so the child's escalation reaches the approval
 * waterfall, and remembers the previous value so disabling restores it.
 *
 * Only the approval policy is ever touched. The sandbox mode is left exactly as
 * delegation seeded it — the gate decides *whether* a one-off widening happens,
 * never how far the child can reach on its own.
 */
export class Knobs {
  constructor(approval) {
    this.approval = approval;
    /** sessionId -> previous policy value. */
    this.saved = new Map();
  }

  current(session) {
    try {
      return this.approval.overrideOf(session) ?? this.approval.config?.policy ?? "never";
    } catch {
      return "never";
    }
  }

  /** Re-arm one child to `ask`. Idempotent; keeps the first remembered value. */
  arm(agent) {
    const session = agent && agent.session;
    if (!session) return false;
    if (!this.saved.has(session.id)) this.saved.set(session.id, this.current(session));
    if (this.current(session) === "ask") return true;
    this.approval.setPolicy(agent, "ask");
    return true;
  }

  /** Put the previous policy back (used when the gate is turned off). */
  restore(agent) {
    const session = agent && agent.session;
    if (!session) return false;
    const previous = this.saved.get(session.id);
    this.saved.delete(session.id);
    if (typeof previous !== "string" || previous === "ask") return false;
    this.approval.setPolicy(agent, previous);
    return true;
  }

  forget(sessionId) {
    this.saved.delete(sessionId);
  }
}
