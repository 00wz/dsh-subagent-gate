# Changelog

## 0.1.3

- **Minimal model-facing note.** The note shown to armed children is reduced to
  the one statement that is actually missing (and false in plain DSH): that
  escalation is relayed to a human. The escalation procedure itself — narrowest
  wider mode, one-shot retry of the exact command, one justification sentence —
  already ships in the model-facing tool schema, identically for parents and
  children. 58 tokens instead of ~200.
- `promptSuffix` config key: append wording without rebuilding.
- `forwardTo` default switched from `auto` to `root`: the confirmation card is
  bound to the session that is currently open, so forwarding to the root session
  is the only target guaranteed to be visible. `auto` (one probe per process)
  and `self` remain available.

## 0.1.2

- Target-strategy registry (`TargetRegistry`, `service.registerTarget`): the
  confirmation transport is now an extension point.
- `forwardTo` may be any registered strategy id; an unknown id falls back to
  `root` instead of failing.

## 0.1.1

- Model-facing note for armed children. Without it a child reads the host's
  unconditional delegation note ("cannot be widened … rejected automatically")
  and refuses to escalate at all, leaving the gate with nothing to decide.

## 0.1.0

- Initial release: coverage of the delegation chain, `never → ask` arming with
  restore, decision pipeline with final/non-final verdicts, human stage with
  routing and fail-closed timeouts, FIFO queue, append-only audit, config
  persistence, `/subagent-gate` command.
