/**
 * dsh-subagent-gate — coverage.
 *
 * Which sessions does the gate manage? Only *delegated children* whose
 * delegation chain still has a human in the loop — i.e. some ancestor is on the
 * `ask` policy. A child of a `danger-full-access`/`never` session needs no gate:
 * it already inherits full access and cannot ask for anything wider.
 *
 * The walk is bounded (the host caps delegation depth) and cycle-safe; a child
 * that was managed once stays managed (sticky), so loosing the ancestor to
 * disposal does not silently un-gate a running subtree.
 */

export const MAX_HOPS = 8;

export class Coverage {
  /**
   * @param {object} deps
   * @param {object} deps.agents   ctx.agents: get(id) -> Agent | undefined
   * @param {object} deps.approval ctx.approval: overrideOf(session), config
   */
  constructor(deps) {
    this.agents = deps.agents;
    this.approval = deps.approval;
    /** sessionId -> true: managed children (sticky). */
    this.managed = new Set();
    /** sessionId -> true: the user turned the gate off for this subtree. */
    this.optOut = new Set();
  }

  /** The policy a session actually runs under right now. */
  policyOf(session) {
    try {
      return this.approval.overrideOf(session) ?? this.approval.config?.policy ?? "ask";
    } catch {
      return "ask";
    }
  }

  /** True when this session is a delegated child at all. */
  static isChild(session) {
    const header = session && session.header;
    return Boolean(header && header.origin === "subagent" && typeof header.parentSession === "string" && header.parentSession !== "");
  }

  /** Deepest ancestor first, up to MAX_HOPS; stops at a disposed ancestor. */
  ancestors(session) {
    const out = [];
    let current = session;
    for (let hop = 0; hop < MAX_HOPS; hop++) {
      const parentId = current && current.header && current.header.parentSession;
      if (typeof parentId !== "string" || parentId === "") break;
      const parent = this.agents.get(parentId);
      if (parent === undefined || !parent.session) break;
      out.push(parent);
      current = parent.session;
    }
    return out;
  }

  /** The nearest ancestor that is NOT a delegated child — the human's session. */
  rootAgent(session) {
    const chain = this.ancestors(session);
    for (let i = chain.length - 1; i >= 0; i--) {
      const agent = chain[i];
      if (!Coverage.isChild(agent.session)) return agent;
    }
    // Every ancestor is a child (should not happen): the topmost one is closest.
    return chain.length > 0 ? chain[chain.length - 1] : undefined;
  }

  /**
   * Decide whether a child is managed.
   * Managed = it is a child, the subtree is not opted out, and some ancestor
   * runs under `ask`.
   */
  isManaged(session) {
    if (!session) return false;
    if (this.optOut.has(session.id)) return false;
    if (this.managed.has(session.id)) return true;
    if (!Coverage.isChild(session)) return false;
    if (this.policyOf(session) === "ask") {
      // The child itself already asks (e.g. re-created after a restart).
      this.managed.add(session.id);
      return true;
    }
    for (const ancestor of this.ancestors(session)) {
      if (this.optOut.has(ancestor.session.id)) return false;
      if (this.policyOf(ancestor.session) === "ask") {
        this.managed.add(session.id);
        return true;
      }
    }
    return false;
  }

  /** Record that this child IS managed (used after a successful arming). */
  markManaged(sessionId) {
    this.managed.add(sessionId);
  }

  /** Turn the gate off for one session and everything below it (live only). */
  optOutTree(sessionId) {
    this.optOut.add(sessionId);
    this.managed.delete(sessionId);
  }

  /** Re-enable a subtree that was opted out. */
  optInTree(sessionId) {
    this.optOut.delete(sessionId);
  }

  /** Drop all bookkeeping for a disposed session. */
  forget(sessionId) {
    this.managed.delete(sessionId);
    this.optOut.delete(sessionId);
  }
}
