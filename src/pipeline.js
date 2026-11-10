/**
 * dsh-subagent-gate — decision pipeline.
 *
 * A stage is the ONLY extension point the core knows about:
 *
 *   {
 *     id: string,                 // stable name, used in config and audit
 *     order?: number,             // pipeline position (default 100)
 *     failClosed?: boolean,       // on throw: true (default) -> deny, false -> abstain
 *     appliesTo?(ctx): boolean,   // cheap scope filter
 *     decide(ctx): string | { decision, final }
 *   }
 *
 * `decide` returns one of `allow | deny | ask | abstain`, either bare (which is
 * final) or wrapped together with `final: false` to let a later stage overturn
 * it. That single flag is what makes an "appeal" stage possible: a judge can
 * deny non-finally and the `human` stage after it can still be asked.
 *
 * When no stage is final, the collected signals are resolved by `strategy`:
 * `strictest` (default) picks deny > ask > allow > abstain.
 */

export const DECISIONS = ["allow", "deny", "ask", "abstain"];

const WEIGHT = { abstain: 0, allow: 1, ask: 2, deny: 3 };

function normalizeVerdict(value) {
  if (typeof value === "string") return DECISIONS.includes(value) ? { decision: value, final: true } : { decision: "abstain", final: true };
  if (value && typeof value === "object") {
    const decision = DECISIONS.includes(value.decision) ? value.decision : "abstain";
    return { decision, final: value.final !== false };
  }
  return { decision: "abstain", final: true };
}

/** Strictest-wins resolution over the collected (non-final) signals. */
export function resolveSignals(signals) {
  let best = "abstain";
  for (const signal of signals) {
    if (WEIGHT[signal.decision] > WEIGHT[best]) best = signal.decision;
  }
  return best;
}

export class Pipeline {
  constructor(stages) {
    this.stages = [...stages].sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
  }

  /** Add or replace a stage by id (future config-driven registration). */
  upsert(stage) {
    this.stages = this.stages.filter((s) => s.id !== stage.id);
    this.stages.push(stage);
    this.stages.sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
    return this;
  }

  /**
   * Run the chain for one request context.
   * @returns {Promise<{decision: string, by: string, signals: Array}>}
   */
  async run(ctx) {
    const signals = [];
    for (const stage of this.stages) {
      if (stage.appliesTo && !stage.appliesTo(ctx)) continue;
      let verdict;
      try {
        verdict = normalizeVerdict(await stage.decide(ctx));
      } catch (error) {
        const failClosed = stage.failClosed !== false;
        signals.push({ stage: stage.id, decision: failClosed ? "deny" : "abstain", error: String(error && error.message ? error.message : error) });
        ctx.onStageError?.(stage.id, error);
        if (failClosed) return { decision: "deny", by: stage.id, signals };
        continue;
      }
      if (verdict.decision === "abstain") continue;
      signals.push({ stage: stage.id, decision: verdict.decision });
      // Later stages can see what already decided (e.g. "human only after a
      // judge denial" reads ctx.signals).
      ctx.signals = signals;
      if (verdict.final) return { decision: verdict.decision, by: stage.id, signals };
    }
    return { decision: resolveSignals(signals), by: "strategy", signals };
  }
}
