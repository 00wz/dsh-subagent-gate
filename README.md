# dsh-subagent-gate

**Ask a human before a delegated subagent widens its sandbox.**

DeepSeek Harness pins every delegated child session to `approval: "never"` (see
`captureDelegatedPolicyOverrides` in `@deepseek-ai/dsh-subagent`), so an
escalation request coming from a subagent is rejected before anybody is asked —
a parent can be asked, its child cannot.

This plugin re-arms exactly that one knob to `ask` for children whose subtree
still has a human in the loop, and answers the resulting approval request by
asking the person. Nothing else changes: the sandbox mode, the permission preset
table and the parent's own behaviour stay stock.

Host-only plugin: no client bundle, no UI strings, no remote methods.

## How it works

```
agent/created ─────► Coverage ─────► Knobs   (child: never → ask)
approval/request ──► Coverage ─────► Pipeline ─────► Outcome ─────► Audit
                                        │
                                        └─ stages: human
                                                   rules / denylist / trust /
                                                   judge / autoapprove (planned)
```

- **Managed children only.** A child is managed when some ancestor runs under
  `ask`. Children of a `danger-full-access` / `never` session are left alone:
  they already inherit full access and have nothing to escalate.
- **Sandbox untouched.** Only the child's *approval policy* changes. The gate
  decides *whether* a one-off widening happens; it never decides how far the
  child can reach on its own.
- **Only approvals are gated.** The plugin hooks `approval/request` and nothing
  else: ordinary tool calls — including calls that the sandbox denies outright —
  never reach it.
- **Fail closed.** Rejection, cancellation, timeout, an unavailable answerer or
  any internal error resolve to `rejected`. `allow` is produced only by
  `allowed-once` from the person.
- **One card at a time.** Concurrent asks are serialized FIFO; a queued ask has
  not started its timeout yet.
- **`allowed-once` only.** One confirmation grants one call and nothing is
  remembered. Leaf grants ("allow this child for its session") are a planned
  stage, not a core change.

## Install

```bash
# npm
dsh plugin --profile <profile> add dsh-subagent-gate

# or from a packed tarball
npm pack
dsh plugin --profile <profile> add ./dsh-subagent-gate-0.1.4.tgz
```

Install a **packed tarball**, not a `link:` on the source directory: a linked
package resolves its `@deepseek-ai/*` peers from outside the profile and fails to
load.

## Configuration

`$DSH_HOME/dsh-subagent-gate/config.json` — created on the first `on`/`off`;
defaults apply while the file is absent:

```json
{
  "version": 1,
  "enabled": true,
  "forwardTo": "root",
  "directProbeMs": 5000,
  "humanTimeoutMs": 0,
  "onTimeout": "reject",
  "onNoAnswerer": "reject",
  "provenance": true,
  "promptSuffix": "",
  "audit": true,
  "stages": [{ "id": "human", "enabled": true, "order": 100 }]
}
```

| key | meaning |
|---|---|
| `forwardTo` | target strategy id for the confirmation card (see below) |
| `directProbeMs` | budget for the one-time `auto` probe; `0` disables probing |
| `humanTimeoutMs` | `0` waits for the human indefinitely; a positive timeout rejects |
| `onTimeout` / `onNoAnswerer` | always `reject`; legacy `allow` values are normalized to `reject` |
| `provenance` | prefix the ask with `[subagent <id> · depth <n>]` and pass a display line |
| `promptSuffix` | extra text appended to the model-facing note |
| `audit` | append one JSONL record per decision to `audit.jsonl` |

### Target strategies

| id | path |
|---|---|
| `root` (default) | show the card in the live non-subagent ancestor's scope; that session must be open in the UI, but its Agent may be idle |
| `self` | the child's own session (visible only while that session is open) |
| `auto` | probe `self` once per process for `directProbeMs`, then fall back to `root` and stay there |
| *any other* | looked up in the target registry; an unknown id falls back to `root` |

`root` is the default because the stock Web UI binds the approval card to the
session that is currently open: a subagent listed in a sidebar tree is still a
*different* session view.

Presentation does **not** start another `approval.request()` in the root. The
child's original open turn owns the one `approval/asked` + `approval/decided`
audit pair. The gate dispatches the public answerer waterfall in the chosen
Agent's scope, so an idle root can display the card without a synthetic turn or
out-of-turn log writes. The forwarded payload names that same presentation Agent.
A child tool's `callId` is kept only for `self`, never resolved in the root's history.

Both the child and presentation Agent must currently have effective `ask` policy;
policy read errors, a missing/replaced Agent, `never`, cancellation and late answers
fail closed. `root` mode does not fall back to `self` if no root is available.
`auto` falls back on a timeout or unavailable self answerer, but not on an explicit
human rejection or cancellation. Probes and regular asks share the same FIFO.

## Commands

```
/subagent-gate status     # mode, target, timeouts, armed children, config path
/subagent-gate on|off     # enable/disable; "off" restores armed children
```

## Architecture

A **stage** is the only extension point the core knows about:

```js
{
  id: "human",
  order: 100,
  failClosed: true,              // a throw denies (default); false abstains
  appliesTo(ctx) { … },          // cheap scope filter
  decide(ctx) { return "allow" | "deny" | "ask" | "abstain"
                     | { decision, final: false }; }
}
```

`final: false` enables an appeal chain: a judge can deny non-finally and the
`human` stage after it is still asked — the "ask the human only after the judge
said no" mode. With no final verdict the collected signals resolve strictly
(`deny > ask > allow`).

| file | role |
|---|---|
| `src/index.js` | cordis wiring: listeners, command, fail-closed boundary |
| `src/coverage.js` | who is managed, root resolution, 8-hop cycle-safe walk |
| `src/knobs.js` | `never → ask`, restore, remember |
| `src/pipeline.js` | ordered stages, final/non-final verdicts, strictest resolution |
| `src/ask.js` | the `human` stage: routing, probe/fallback, timeout, provenance |
| `src/targets.js` | target-strategy registry — the confirmation-UX extension point |
| `src/queue.js` | one card at a time |
| `src/audit.js` | append-only JSONL |
| `src/config.js` | defaults, normalization, persistence |
| `src/prompt.js` | the model-facing note for armed children |

### Extension points

1. **Stages** — `pipeline.upsert({ id, order, decide })` plus a config entry.
   `rules`, `denylist`, `trust`, `judge`, `autoapprove` are planned as stages.
2. **Target strategies** — `service.registerTarget(id, (ctx, gate) => ({ agent, path, probe? }))`
   so another plugin can add a transport (modal, notification, webhook, a
   dedicated approvals session) without touching this code.
3. **`promptSuffix`** — extra model-facing wording without a rebuild. Add rules
   there only after an observed failure, not speculatively.

## Compatibility

Requires DSH `>=0.2.2-rc.5` (`engines.dsh`). This repair targets the tested
turn-enclosed approval and scoped-answerer API; older DSH releases are not claimed
as supported. Host peers are supplied by DSH, including its singleton
`@deepseek-ai/dsh-scope` (do not bundle a second scope implementation).

Public seams: `agent/created`, `approval/request`, `approval.setPolicy`,
`approval.overrideOf`, `scopeTarget`, `systemPrompt.context`, `commands.register`.
The gate's prompt contribution is ordered after DSH's delegation context.
Disabling or unloading cancels pending presentations and restores gate-armed
children; the `on` command remains available when the plugin starts disabled.

## Limitations

- **A card is bound to the session you are viewing** — hence the `root` default.
- **Approval asks only.** Calls that would bypass the sandbox without asking
  (for example an MCP tool whose server does the I/O in its own process) are not
  seen by this plugin. Closing that needs a per-call stage on `tools/pre-execute`.
- **One model-facing sentence contradicts the host.** DSH appends an
  unconditional delegation note to every child ("your permission scope cannot be
  widened … rejected automatically"). It is true only while the child is pinned
  to `never` — the very thing this plugin changes — so the gate states the real
  contract and stops there. The escalation procedure itself ("narrowest wider
  mode", "one-shot retry of the exact command", "one sentence of justification")
  is already in the model-facing tool schema, identical for parents and children.
  The clean fix belongs upstream: emit the delegation note only when the policy
  is `never`, the way the `never` policy sentence already is.

## Development

```bash
node test/run.mjs     # behavior and safety regressions; no host required
npm pack             # produces the installable tarball
```

`test/integration.mjs` runs against the installed DSH runtime (`DSH_INSTALL_DIR`),
using isolated sessions, the actual Cordis scope/approval services and a simulated
human answerer. Run it with `DSH_NODE_EXECUTABLE` and `ELECTRON_RUN_AS_NODE=1`
for Desktop/ASAR. It must not run against the live profile's Agents or approval
policy. A green integration run is not evidence that a real browser card rendered;
manual UI acceptance remains a separate check.

## Roadmap

1. `rules` — declarative allow/deny on tool + args.
2. `denylist` — dangerous-command patterns with normalized matching.
3. `trust` — an identical call already approved in this session.
4. `judge` — LLM auto-approval; with `final: false` on denial the `human` stage
   becomes "ask only after the judge rejected".
5. `autoapprove` — pattern whitelist, so routine widenings never reach a person.
6. Leaf grants — "allow this child for the rest of its session".
7. Optional scope filter — restrict the gate to selected workspaces/roots.

## License

MIT — see [LICENSE](LICENSE).
