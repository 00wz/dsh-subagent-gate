/**
 * dsh-subagent-gate — model-facing note for armed children.
 *
 * Minimal on purpose. Everything about *how* to escalate is already in the
 * model-facing tool schema, byte-identical for parents and children:
 *
 *   sandbox_permissions: "The narrowest wider sandbox mode for a one-shot retry
 *     of the exact command the sandbox just denied; the retry asks the user for
 *     approval."
 *   justification: "Required with sandbox_permissions: one sentence for the user
 *     explaining why this exact command needs the wider access."
 *
 * The sandbox denial itself repeats the same procedure, and the host's
 * delegation note already says "do not retry the denied operation".
 *
 * The ONE thing that is false for a child is the last part of that schema
 * sentence: for a child the retry does NOT ask the user — `@deepseek-ai/dsh-subagent`
 * pins the child to `never` and appends "your permission scope … cannot be
 * widened … rejected automatically". The gate changes exactly that, so the note
 * only has to say so. Extra rules are configurable (`promptSuffix`) and should
 * be added only after an observed failure, not speculatively.
 */
export const GATE_PROMPT =
  "Escalation is enabled in this session: a one-shot sandbox_permissions retry is relayed to the human operator, who decides it. " +
  "The delegation note saying escalation is rejected automatically does not apply here.";

/**
 * Build the system-prompt contribution.
 * @param {object} deps
 * @param {object} deps.coverage Coverage instance (managed children only)
 * @param {Function} deps.isChild session predicate
 * @param {string} [deps.suffix] optional extra text from config (`promptSuffix`)
 */
export function createGatePrompt({ coverage, isChild, suffix = "", enabled = () => true, order = 121 }) {
  const extra = typeof suffix === "string" && suffix.trim() !== "" ? " " + suffix.trim() : "";
  return {
    name: "subagent-gate:escalation",
    // After the host's delegation note (`subagent:delegation`) and after the
    // policy contributions, so it reads as the exception to them.
    order,
    text: (context) => {
      if (!enabled()) return "";
      const agent = context && context.agent;
      const session = agent && agent.session;
      if (!session || !isChild(session)) return "";
      if (!coverage.isManaged(session) || coverage.policyOf(session) !== "ask") return "";
      return GATE_PROMPT + extra;
    },
  };
}
