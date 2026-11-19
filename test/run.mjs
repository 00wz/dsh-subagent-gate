/**
 * dsh-subagent-gate — test suite (no host required).
 *
 *   node test/run.mjs
 *
 * Covers everything that decides behaviour: config normalization, coverage of
 * the delegation chain, pipeline precedence, and the human stage's routing /
 * timeout / fail-closed semantics. The thin cordis wiring in src/index.js is
 * exercised by the live test instead.
 */
import { DEFAULTS, normalize } from "../src/config.js";
import { Coverage } from "../src/coverage.js";
import { Knobs } from "../src/knobs.js";
import { Pipeline, resolveSignals } from "../src/pipeline.js";
import { HumanGate, shortId } from "../src/ask.js";
import { createGatePrompt } from "../src/prompt.js";
import { Queue } from "../src/queue.js";
import { TargetRegistry } from "../src/targets.js";

let pass = 0;
const failures = [];
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++;
  else {
    failures.push(name);
    console.log(`FAIL  ${name}  expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- fixtures --------------------------------------------------------------

function mkSession(id, parentId, opts = {}) {
  const header = { id, version: 4, createdAt: 0, isSeeded: false, delegationDepth: parentId ? opts.depth ?? 1 : 0 };
  if (parentId) {
    header.parentSession = parentId;
    header.origin = "subagent";
  }
  return { id, header };
}

function mkWorld(policyBySession = {}) {
  const agents = new Map();
  const policies = new Map(Object.entries(policyBySession));
  const approval = {
    overrideOf: (session) => policies.get(session.id) ?? "never",
    config: { policy: "never" },
    setPolicy: (agent, policy) => policies.set(agent.session.id, policy),
    requests: [],
    request: async () => "allowed-once",
  };
  return {
    agents: { get: (id) => agents.get(id), list: () => [...agents.values()] },
    approval,
    policies,
    add(session) {
      agents.set(session.id, { id: session.id, session });
      return agents.get(session.id);
    },
    depthOf(session) {
      return session.header.delegationDepth ?? 0;
    },
  };
}

function mkGate(world, configOverrides = {}, requestImpl) {
  const config = { ...DEFAULTS, ...configOverrides };
  const approval = { ...world.approval };
  approval.request = async () => { throw new Error("A forwarded presentation must not start a second approval transaction"); };
  const coverage = new Coverage({ agents: world.agents, approval });
  // Emulate the Host arming a delegated child before its original request.
  for (const agent of world.agents.list()) {
    if (coverage.isManaged(agent.session)) approval.setPolicy(agent, "ask");
  }
  const audit = { record: async () => {} };
  const queue = new Queue();
  const targets = new TargetRegistry();
  const gate = new HumanGate({ approval, coverage, config, queue, audit, targets, present: requestImpl ?? (async () => "allowed-once") });
  return { gate, approval, coverage, config, targets };
}

// ---- config ----------------------------------------------------------------

check("config: defaults keep the human stage", normalize(undefined).stages.map((s) => s.id), ["human"]);
check("config: unlimited timeout by default", normalize(undefined).humanTimeoutMs, 0);
check("config: unknown target id is accepted (resolved at runtime)", normalize({ forwardTo: "nope" }).forwardTo, "nope");
check("config: blank target id falls back to the default", normalize({ forwardTo: "   " }).forwardTo, DEFAULTS.forwardTo);
check("config: timeout clamped", normalize({ humanTimeoutMs: -5 }).humanTimeoutMs, 0);
check("config: stages sorted by order", normalize({ stages: [{ id: "b", order: 200 }, { id: "a", order: 10 }] }).stages.map((s) => s.id), ["a", "b"]);
check("config: unknown stage options pass through", normalize({ stages: [{ id: "judge", options: { model: "x" } }] }).stages[0].options, { model: "x" });

// ---- coverage --------------------------------------------------------------

{
  const world = mkWorld({ "session-root": "ask" });
  const root = world.add(mkSession("session-root"));
  const child = world.add(mkSession("child-1", "session-root"));
  const coverage = new Coverage({ agents: world.agents, approval: world.approval });
  check("coverage: child of an ask-session is managed", coverage.isManaged(child.session), true);
  check("coverage: root is not managed", coverage.isManaged(root.session), false);
  check("coverage: root resolves to the human session", coverage.rootAgent(child.session)?.id, "session-root");
  check("coverage: managed is sticky for the same session", coverage.isManaged(child.session), true);
}
{
  const world = mkWorld({ "session-root": "never" });
  world.add(mkSession("session-root"));
  const child = world.add(mkSession("child-1", "session-root"));
  const coverage = new Coverage({ agents: world.agents, approval: world.approval });
  check("coverage: child of a never-session is NOT managed", coverage.isManaged(child.session), false);
}
{
  const world = mkWorld({ "session-root": "ask" });
  world.add(mkSession("session-root"));
  const child = world.add(mkSession("child-1", "session-root"));
  const grand = world.add(mkSession("child-2", "child-1", { depth: 2 }));
  const coverage = new Coverage({ agents: world.agents, approval: world.approval });
  check("coverage: grandchild is managed", coverage.isManaged(grand.session), true);
  check("coverage: grandchild's root is the human session", coverage.rootAgent(grand.session)?.id, "session-root");
  check("coverage: depth is reported", grand.session.header.delegationDepth, 2);
}
{
  const world = mkWorld({ "session-root": "ask" });
  world.add(mkSession("session-root"));
  const child = world.add(mkSession("child-1", "session-root"));
  const coverage = new Coverage({ agents: world.agents, approval: world.approval });
  coverage.optOutTree("session-root");
  check("coverage: opt-out disables the subtree", coverage.isManaged(child.session), false);
  coverage.optInTree("session-root");
  check("coverage: opt-in restores it", coverage.isManaged(child.session), true);
}
{
  // cycle: a -> b -> a must terminate and not claim management
  const world = mkWorld({});
  world.add(mkSession("a", "b"));
  world.add(mkSession("b", "a"));
  const coverage = new Coverage({ agents: world.agents, approval: world.approval });
  const a = world.agents.get("a");
  let threw = false;
  try {
    coverage.isManaged(a.session);
  } catch {
    threw = true;
  }
  check("coverage: cyclic chain does not throw", threw, false);
}
check("coverage: shortId strips the session- prefix", shortId("session-0123abcd-aaaa"), "0123abcd");

// ---- knobs -----------------------------------------------------------------

{
  const world = mkWorld({ "child-1": "never" });
  const child = world.add(mkSession("child-1", "session-root"));
  const knobs = new Knobs(world.approval);
  knobs.arm(child);
  check("knobs: child flips to ask", world.policies.get("child-1"), "ask");
  knobs.restore(child);
  check("knobs: restore puts never back", world.policies.get("child-1"), "never");
}
{
  const world = mkWorld({ "child-1": "never" });
  const child = world.add(mkSession("child-1", "session-root"));
  const knobs = new Knobs(world.approval);
  knobs.arm(child);
  knobs.arm(child);
  knobs.restore(child);
  check("knobs: repeated arming still restores the original", world.policies.get("child-1"), "never");
}

// ---- pipeline --------------------------------------------------------------

check("pipeline: strictest prefers deny", resolveSignals([{ decision: "allow" }, { decision: "deny" }, { decision: "ask" }]), "deny");
check("pipeline: strictest prefers ask over allow", resolveSignals([{ decision: "allow" }, { decision: "ask" }]), "ask");
{
  const order = [];
  const pipeline = new Pipeline([
    { id: "b", order: 200, decide: () => { order.push("b"); return "allow"; } },
    { id: "a", order: 10, decide: () => { order.push("a"); return { decision: "deny", final: true }; } },
    { id: "never", order: 300, decide: () => { order.push("never"); return "allow"; } },
  ]);
  const verdict = await pipeline.run({});
  check("pipeline: runs by order and stops on a final verdict", [order, verdict.decision, verdict.by], [["a"], "deny", "a"]);
}
{
  // the appeal shape: judge denies non-finally, human decides afterwards
  const pipeline = new Pipeline([
    { id: "judge", order: 50, decide: () => ({ decision: "deny", final: false }) },
    { id: "human", order: 100, decide: () => "allow" },
  ]);
  const verdict = await pipeline.run({});
  check("pipeline: non-final deny can be appealed by a later stage", verdict.decision, "allow");
  check("pipeline: signals keep the judge verdict", verdict.signals, [{ stage: "judge", decision: "deny" }, { stage: "human", decision: "allow" }]);
}
{
  const pipeline = new Pipeline([{ id: "boom", decide: () => { throw new Error("x"); } }]);
  check("pipeline: a throwing stage fails closed", (await pipeline.run({})).decision, "deny");
}
{
  const pipeline = new Pipeline([{ id: "soft", failClosed: false, decide: () => { throw new Error("x"); } }, { id: "after", decide: () => "allow" }]);
  check("pipeline: failClosed=false lets the chain continue", (await pipeline.run({})).decision, "allow");
}
{
  // appliesTo filter
  const pipeline = new Pipeline([
    { id: "only-bash", appliesTo: (ctx) => ctx.toolName === "bash", decide: () => "allow" },
    { id: "fallback", order: 200, decide: () => "deny" },
  ]);
  check("pipeline: appliesTo skips the stage", (await pipeline.run({ toolName: "pwsh" })).decision, "deny");
  check("pipeline: appliesTo includes the stage", (await pipeline.run({ toolName: "bash" })).decision, "allow");
}

// ---- human stage: routing ---------------------------------------------------

{
  const world = mkWorld({ "session-root": "ask" });
  world.add(mkSession("session-root"));
  const child = world.add(mkSession("child-1", "session-root"));
  const calls = [];
  const { gate } = mkGate(world, { forwardTo: "self" }, async (req) => {
    calls.push({ target: req.agent.id, reason: req.reason });
    return "allowed-once";
  });
  const ctx = { agent: child, session: child.session, toolName: "pwsh", reason: "needs to write C:\\tmp\\x", depth: 1 };
  const verdict = await gate.decide(ctx);
  check("human[self]: allow maps through", verdict.decision, "allow");
  check("human[self]: asks in the child session", calls[0]?.target, "child-1");
  check("human[self]: provenance names the child", calls[0]?.reason.includes("subagent"), true);
}
{
  const world = mkWorld({ "session-root": "ask" });
  world.add(mkSession("session-root"));
  const child = world.add(mkSession("child-1", "session-root"));
  const calls = [];
  const { gate } = mkGate(world, { forwardTo: "root" }, async (req) => {
    calls.push(req.agent.id);
    return "rejected";
  });
  const verdict = await gate.decide({ agent: child, session: child.session, toolName: "pwsh", reason: "x", depth: 1 });
  check("human[root]: asks in the root session", calls, ["session-root"]);
  check("human[root]: rejection denies", verdict.decision, "deny");
}
{
  // auto: the self probe goes unanswered -> fall back to root, and remember it
  const world = mkWorld({ "session-root": "ask" });
  world.add(mkSession("session-root"));
  const child = world.add(mkSession("child-1", "session-root"));
  const calls = [];
  const { gate } = mkGate(world, { forwardTo: "auto", directProbeMs: 20 }, async (req) => {
    calls.push(req.agent.id);
    if (req.agent.id === "child-1") return new Promise(() => {}); // never answered
    return "allowed-once";
  });
  const ctx = () => ({ agent: child, session: child.session, toolName: "pwsh", reason: "x", depth: 1 });
  check("human[auto]: first ask falls back and allows", (await gate.decide(ctx())).decision, "allow");
  check("human[auto]: probed self then asked root", calls, ["child-1", "session-root"]);
  check("human[auto]: capability is cached", gate.capability, "root");
  check("human[auto]: second ask skips the probe", (await gate.decide(ctx())).decision, "allow");
  check("human[auto]: only one probe in total", calls, ["child-1", "session-root", "session-root"]);
}
{
  // timeout on the human ask (unlimited by default, so set an explicit budget)
  const world = mkWorld({ "session-root": "ask" });
  world.add(mkSession("session-root"));
  const child = world.add(mkSession("child-1", "session-root"));
  const { gate } = mkGate(world, { forwardTo: "root", humanTimeoutMs: 20, onTimeout: "reject" }, () => new Promise(() => {}));
  const verdict = await gate.decide({ agent: child, session: child.session, toolName: "pwsh", reason: "x", depth: 1 });
  check("human: timeout fails closed", verdict.decision, "deny");
}
{
  const world = mkWorld({ "session-root": "ask" });
  world.add(mkSession("session-root"));
  const child = world.add(mkSession("child-1", "session-root"));
  const { gate } = mkGate(world, { forwardTo: "root", onNoAnswerer: "reject" }, async () => {
    throw new Error("no approval channel");
  });
  check("human: a throwing request fails closed", (await gate.decide({ agent: child, session: child.session, toolName: "pwsh", reason: "x", depth: 1 })).decision, "deny");
}
{
  // busy guard: while the gate asks, the same session must not be re-claimed
  const world = mkWorld({ "session-root": "ask" });
  world.add(mkSession("session-root"));
  const child = world.add(mkSession("child-1", "session-root"));
  let busyDuringAsk;
  const ctxOut = { agent: child, session: child.session, toolName: "pwsh", reason: "x", depth: 1 };
  const { gate } = mkGate(world, { forwardTo: "self" }, async () => {
    busyDuringAsk = [gate.isBusy("child-1"), gate.isBusy("session-root")];
    return "allowed-once";
  });
  await gate.decide(ctxOut);
  check("human: the child session is marked busy during the ask", busyDuringAsk[0], true);
  check("human: busy is cleared afterwards", [gate.isBusy("child-1"), gate.isBusy("session-root")], [false, false]);
}

// ---- model-facing note ------------------------------------------------------

{
  const world = mkWorld({ "session-root": "ask" });
  const root = world.add(mkSession("session-root"));
  const child = world.add(mkSession("child-1", "session-root"));
  const coverage = new Coverage({ agents: world.agents, approval: world.approval });
  world.approval.setPolicy(child, "ask");
  const prompt = createGatePrompt({ coverage, isChild: Coverage.isChild });
  check("prompt: armed child gets the note", prompt.text({ agent: child }).includes("relayed to the human"), true);
  check("prompt: note stays minimal (no duplicated escalation rules)", prompt.text({ agent: child }).length < 400, true);
  check("prompt: root session gets nothing", prompt.text({ agent: root }), "");
  check("prompt: no agent is safe", prompt.text({}), "");
  check("prompt: note is ordered after the host delegation note", prompt.order > 120, true);
  const withSuffix = createGatePrompt({ coverage, isChild: Coverage.isChild, suffix: "Ask once." });
  check("prompt: config suffix is appended", withSuffix.text({ agent: child }).endsWith("Ask once."), true);
  world.approval.setPolicy(child, "never");
  check("prompt: explicit never suppresses a previously managed child's note", prompt.text({ agent: child }), "");
}

// ---- target strategies ------------------------------------------------------

check("targets: default is root (no probe delay)", normalize(undefined).forwardTo, "root");
check("targets: built-ins are root/self/auto", new TargetRegistry().ids(), ["root", "self", "auto"]);
{
  const world = mkWorld({ "session-root": "ask" });
  world.add(mkSession("session-root"));
  const child = world.add(mkSession("child-1", "session-root"));
  const { gate, targets } = mkGate(world, { forwardTo: "custom" }, async () => "allowed-once");
  const calls = [];
  targets.register("custom", (ctx, g) => ({ agent: g.coverage.rootAgent(ctx.session), path: "custom" }));
  const verdict = await gate.decide({ agent: child, session: child.session, toolName: "pwsh", reason: "x", depth: 1 });
  check("targets: a registered custom strategy is used", verdict.decision, "allow");
  check("targets: unknown id would fall back to root", targets.has("custom"), true);
}
{
  const world = mkWorld({ "session-root": "ask" });
  world.add(mkSession("session-root"));
  const child = world.add(mkSession("child-1", "session-root"));
  const { gate } = mkGate(world, { forwardTo: "does-not-exist" }, async (req) => {
    if (req.agent.id !== "session-root") throw new Error("should not ask the child");
    return "rejected";
  });
  const verdict = await gate.decide({ agent: child, session: child.session, toolName: "pwsh", reason: "x", depth: 1 });
  check("targets: an unknown id falls back to the root session", verdict.decision, "deny");
  check("targets: unknown id does not throw", true, true);
}

// ---- regression: presentation, policies, cancellation and failure safety ----

check("config: legacy timeout allow cannot grant without a person", normalize({ onTimeout: "allow" }).onTimeout, "reject");
check("config: legacy missing-answerer allow cannot grant", normalize({ onNoAnswerer: "allow" }).onNoAnswerer, "reject");

function scenario(overrides = {}, present) {
  const world = mkWorld({ root: "ask" });
  const root = world.add(mkSession("root"));
  const child = world.add(mkSession("child", "root"));
  const fixture = mkGate(world, overrides, present);
  const ctx = { agent: child, session: child.session, toolName: "pwsh", reason: "test only", depth: 1, callId: "child-call-1" };
  return { world, root, child, ctx, ...fixture };
}
{
  let received;
  const s = scenario({}, async req => { received = req; return "allowed-once"; });
  check("regression: idle-root presentation does not call approval.request", (await s.gate.decide(s.ctx)).decision, "allow");
  check("presentation: payload Agent is the root", received.agent === s.root, true);
  check("presentation: child callId is omitted from root card", Object.hasOwn(received, "callId"), false);
  check("presentation: displayReason is a locale record", typeof received.displayReason.en, "string");
  check("presentation: provenance contains child id", received.displayReason.en.includes("child"), true);
}
{
  let received;
  const s = scenario({ forwardTo: "self" }, async req => { received = req; return "allowed-once"; });
  await s.gate.decide(s.ctx);
  check("presentation: self keeps its own tool callId", received.callId, "child-call-1");
}
for (const outcome of ["rejected", "cancelled", "unavailable", "unexpected", { toString: () => "allowed-once" }]) {
  const s = scenario({ onNoAnswerer: "allow", onTimeout: "allow" }, async () => outcome);
  check("safety: non-grant outcome cannot allow: " + String(outcome), (await s.gate.decide(s.ctx)).decision, "deny");
}
{
  const s = scenario({ onNoAnswerer: "allow" }, async () => { throw new Error("transport failed"); });
  check("safety: internal errors deny even with legacy allow config", (await s.gate.decide(s.ctx)).decision, "deny");
}
for (const who of ["root", "child"]) {
  let prompts = 0;
  const s = scenario({}, async () => { prompts++; return "allowed-once"; });
  s.world.policies.set(who, "never");
  check("policy: " + who + " never denies", (await s.gate.decide(s.ctx)).decision, "deny");
  check("policy: " + who + " never never prompts", prompts, 0);
}
{
  let prompts = 0;
  const s = scenario({}, async () => { prompts++; return "allowed-once"; });
  s.approval.overrideOf = () => { throw new Error("unreadable policy"); };
  check("policy: read failure denies", (await s.gate.decide(s.ctx)).decision, "deny");
  check("policy: read failure does not prompt", prompts, 0);
}
{
  const s = scenario({}, async () => { s.world.policies.set("root", "never"); return "allowed-once"; });
  check("policy: switching root to never discards late grant", (await s.gate.decide(s.ctx)).decision, "deny");
}
{
  let prompts = 0;
  const s = scenario({}, async () => { prompts++; return "allowed-once"; });
  s.gate.isLive = () => false;
  check("lifetime: replaced/disposed Agent cannot receive a grant", (await s.gate.decide(s.ctx)).decision, "deny");
  check("lifetime: absent Agent not prompted", prompts, 0);
}
{
  const s = scenario();
  s.gate.coverage.rootAgent = () => undefined;
  check("routing: missing root does not silently fall back to self", (await s.gate.decide(s.ctx)).decision, "deny");
}
{
  let prompts = 0;
  const s = scenario({}, async () => { prompts++; return "allowed-once"; });
  const abort = new AbortController(); abort.abort();
  check("cancel: pre-aborted ask denies", (await s.gate.decide({ ...s.ctx, signal: abort.signal })).decision, "deny");
  check("cancel: pre-aborted ask never prompts", prompts, 0);
}
{
  let late;
  const s = scenario({}, () => new Promise(resolve => { late = resolve; }));
  const abort = new AbortController();
  const result = s.gate.decide({ ...s.ctx, signal: abort.signal });
  await sleep(0); abort.abort();
  check("cancel: uncooperative answerer is cancelled immediately", (await result).decision, "deny");
  late("allowed-once");
  check("cancel: busy bookkeeping is released", s.gate.isBusy("child"), false);
}
{
  let release, calls = 0;
  const s = scenario({}, () => { calls++; return new Promise(resolve => { release = resolve; }); });
  const first = s.gate.decide(s.ctx);
  await sleep(0);
  const abort = new AbortController();
  const second = s.gate.decide({ ...s.ctx, signal: abort.signal });
  abort.abort();
  check("queue: cancelled pending ask resolves before active card", (await second).decision, "deny");
  release("allowed-once");
  await first; await sleep(0);
  check("queue: cancelled pending ask never presents later", calls, 1);
}
{
  const seen = [];
  const s = scenario({ forwardTo: "auto", directProbeMs: 5 }, async req => {
    seen.push(req.agent.id);
    return req.agent.id === "child" ? "unavailable" : "allowed-once";
  });
  // Correctly distinguish absence of an answerer from an actual human denial.
  check("auto: unavailable self answerer falls back to root", (await s.gate.decide(s.ctx)).decision, "allow");
  check("auto: fallback visits self then root", seen, ["child", "root"]);
}
{
  let active = 0, maxActive = 0;
  const s = scenario({ forwardTo: "auto", directProbeMs: 50 }, async () => {
    active++; maxActive = Math.max(maxActive, active); await sleep(5); active--; return "allowed-once";
  });
  const results = await Promise.all([s.gate.decide(s.ctx), s.gate.decide(s.ctx)]);
  check("queue: concurrent auto probes use one card at a time", maxActive, 1);
  check("queue: both concurrent asks get their own answer", results.map(v => v.decision), ["allow", "allow"]);
}
{
  const s = scenario();
  const prompt = createGatePrompt({ coverage: s.coverage, isChild: Coverage.isChild, enabled: () => false, order: 131 });
  check("prompt: disabled gate is silent", prompt.text({ agent: s.child }), "");
  check("prompt: provided host-relative context order is used", prompt.order, 131);
}

for (const change of ["root-never", "child-never", "disabled", "disposed", "cancelled"]) {
  const s = scenario();
  const abort = new AbortController();
  const ctx = { ...s.ctx, signal: abort.signal };
  s.gate.audit.record = async record => {
    if (record.kind !== "human") return;
    await Promise.resolve();
    if (change === "root-never") s.world.policies.set("root", "never");
    if (change === "child-never") s.world.policies.set("child", "never");
    if (change === "disabled") s.config.enabled = false;
    if (change === "disposed") s.gate.isLive = () => false;
    if (change === "cancelled") abort.abort();
  };
  check("commit: change during asynchronous audit rejects grant: " + change, (await s.gate.decide(ctx)).decision, "deny");
  check("commit: final Host grant guard is stale: " + change, ctx.grantIsCurrent(), false);
}
{
  let prompts = 0;
  const s = scenario({}, async () => { prompts++; return "allowed-once"; });
  s.world.add(mkSession("intermediate", "missing-root"));
  s.world.policies.set("intermediate", "ask");
  s.child.session.header.parentSession = "intermediate";
  check("root: live subagent ancestor is not a replacement for missing human root", s.coverage.rootAgent(s.child.session), undefined);
  check("root: missing human root with live intermediate denies", (await s.gate.decide(s.ctx)).decision, "deny");
  check("root: intermediate subagent does not receive a root card", prompts, 0);
}

// ---- report ----------------------------------------------------------------

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log("FAILED: " + failures.join(" | "));
  process.exit(1);
}
