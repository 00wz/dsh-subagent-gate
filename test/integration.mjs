/**
 * Real installed-runtime integration. No profile, real sessions, UI or prompts.
 * PowerShell (Electron is required for modules inside app.asar):
 *   $env:ELECTRON_RUN_AS_NODE='1'
 *   & $env:DSH_NODE_EXECUTABLE test/integration.mjs | Write-Output
 *
 * Only session/agent storage, projection storage, ancillary services and human
 * answers are fake. Cordis lifecycle/dispatch, scope routing, ApprovalService,
 * its actual projection reducer, and the patched Host plugin all run unchanged.
 */
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

assert.ok(process.versions.electron, 'Run with DSH_NODE_EXECUTABLE and ELECTRON_RUN_AS_NODE=1 (ASAR support)');
assert.ok(process.env.DSH_INSTALL_DIR, 'DSH_INSTALL_DIR must identify the installed CLI anchor');
const hostRequire = createRequire(join(process.env.DSH_INSTALL_DIR, 'package.json'));
const hostManifest = hostRequire('./package.json');
assert.equal(hostManifest.name, '@deepseek-ai/dsh');
const hostAnchorURL = pathToFileURL(join(process.env.DSH_INSTALL_DIR, 'package.json')).href;
const hook = registerHooks({
  resolve(specifier, context, nextResolve) {
    // Preserve import/require conditions (some installed dependencies are CJS),
    // changing only their resolution parent to the verified installed host.
    return nextResolve(specifier, specifier.startsWith('@deepseek-ai/')
      ? { ...context, parentURL: hostAnchorURL } : context);
  },
});

// Set before ANY plugin import: config.js captures DSH_HOME at module load.
const oldHome = process.env.DSH_HOME;
const isolatedHome = await mkdtemp(join(tmpdir(), 'dsh-subagent-gate-integration-'));
process.env.DSH_HOME = isolatedHome;
const configDir = join(isolatedHome, 'dsh-subagent-gate');
await mkdir(configDir);
const baseConfig = { enabled: true, audit: true, forwardTo: 'root', humanTimeoutMs: 1000 };
await writeFile(join(configDir, 'config.json'), JSON.stringify(baseConfig));

const { Context, Service } = await import('@deepseek-ai/cordis');
const { ApprovalService, setApprovalPolicy } = await import('@deepseek-ai/dsh-user-approval');
const { createScope, isScopeCarrier, carrierKeyOf } = await import('@deepseek-ai/dsh-scope');
const { SubagentGate } = await import('../src/index.js');
const { DATA_DIR } = await import('../src/config.js');
assert.equal(resolve(DATA_DIR), resolve(configDir));
assert.ok(SubagentGate.prototype instanceof Service);
console.log(`Runtime: DSH ${hostManifest.version}; Electron ${process.versions.electron}; Node ${process.versions.node}`);
console.log(`Actual modules: ${hostRequire.resolve('@deepseek-ai/cordis')}; ${hostRequire.resolve('@deepseek-ai/dsh-user-approval')}`);
console.log('Isolation: temporary DSH_HOME; fake sessions/agents; mocked scoped answerers only');

const auditEvents = session => session.events.filter(e => e.type === 'approval/asked' || e.type === 'approval/decided');
const tick = () => new Promise(resolveTick => setImmediate(resolveTick));
let pass = 0;
let fail = 0;
let serial = 0;
const worlds = new Set();
async function test(name, body) {
  try {
    await body();
    pass++;
    console.log(`PASS ${name}`);
  } catch (error) {
    fail++;
    console.error(`FAIL ${name}\n${error.stack ?? error}`);
  }
}
async function bounded(promise, description) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${description}`)), 5000);
    })]);
  } finally { clearTimeout(timer); }
}

async function world({ answer = 'allowed-once', mode = 'root', answerers = true, withIntermediate = false, initiallyEnabled = true } = {}) {
  // Each fixture explicitly chooses persisted startup state independently.
  await writeFile(join(configDir, 'config.json'), JSON.stringify({ ...baseConfig, enabled: initiallyEnabled }));
  const id = ++serial;
  const ctx = new Context();
  const allAgents = new Map();
  const states = new Map();
  let definition;
  let registerCount = 0;
  const commands = new Map();
  const prompts = [];
  const faults = [];
  ctx.logger.exporter({ export(message) {
    if (message.type === 'error') faults.push(message.args);
  } });
  function agent(name, parent) {
    const session = {
      id: `session-integration-${id}-${name}`,
      header: { origin: parent ? 'subagent' : 'human', delegationDepth: parent ? 1 : 0,
        ...(parent ? { parentSession: parent.session.id } : {}) },
      events: [],
      append(type, data) {
        const event = { type, data };
        this.events.push(event);
        if (definition) states.set(this, definition.apply(states.get(this) ?? definition.init(), event));
        return event;
      },
    };
    const value = { session, injected: [], inject(message) { this.injected.push(message); } };
    allAgents.set(session.id, value);
    return value;
  }
  const root = agent('root');
  const intermediate = withIntermediate ? agent('intermediate', root) : undefined;
  const child = agent('child', intermediate ?? root);
  // Exactly the actual delegated-policy order: never FIRST, plugin arming later.
  setApprovalPolicy(root.session, 'ask');
  if (intermediate) setApprovalPolicy(intermediate.session, 'never');
  setApprovalPolicy(child.session, 'never');
  child.session.append('turn/start', {});
  ctx.provide('sessionProjections', {
    async register(actualDefinition) {
      registerCount++;
      definition = actualDefinition;
      assert.equal(definition.key, 'approvalState');
      for (const agent of allAgents.values()) {
        let state = definition.init();
        for (const event of agent.session.events) state = definition.apply(state, event);
        states.set(agent.session, state);
      }
      return { stateOf(session) {
        assert.ok(states.has(session), 'Projection accepts the exact fake session identity');
        return states.get(session);
      } };
    },
  });
  ctx.provide('agents', { get: id => allAgents.get(id), list: () => [...allAgents.values()] });
  ctx.provide('systemPrompt', { context: prompt => prompts.push(prompt), getContextOrder: () => 100 });
  ctx.provide('commands', { register: command => commands.set(command.name, command) });
  const approvalFiber = ctx.plugin(ApprovalService, { policy: 'ask' });
  await bounded(approvalFiber.await(), 'mount actual ApprovalService');
  assert.equal(registerCount, 1);
  const approval = ctx.approval;
  assert.ok(approval instanceof ApprovalService);
  assert.equal(approval.overrideOf(child.session), 'never');
  assert.equal(approval.overrideOf(root.session), 'ask');
  assert.equal(states.get(child.session).turnOpen, true);
  assert.equal(states.get(root.session).turnOpen, false);
  const gateFiber = ctx.plugin(SubagentGate);
  await bounded(gateFiber.await(), 'mount patched SubagentGate');
  const gate = ctx.subagentGate;
  gate.config.forwardTo = mode;
  assert.equal(gateFiber.state, 2);
  assert.equal(approval.overrideOf(child.session), initiallyEnabled ? 'ask' : 'never',
    'Enabled gate must arm child; persisted disabled gate must preserve delegated never');
  assert.equal(approval.overrideOf(root.session), 'ask');
  assert.equal(ctx.agents.get(child.session.id), child);
  assert.equal(ctx.agents.get(root.session.id), root);
  assert.equal(gate.armed.has(child.session.id), initiallyEnabled);
  assert.equal(prompts.length, 2, 'Real ApprovalService and Gate registered their system prompts');

  const presentations = [];
  const scopes = [];
  function mockAnswerer(target) {
    const scope = createScope(ctx, target);
    scopes.push(scope);
    scope.ctx.on('approval/request', function(req) {
      // Assertion errors here get contained by the production approval path;
      // record explicitly as well so that fail-closed cannot conceal a bad scope.
      try {
        assert.ok(isScopeCarrier(this), 'waterfall receiver is a real scopeTarget carrier');
        assert.equal(carrierKeyOf(this), target, 'carrier uses target Agent identity, not session/id');
        assert.equal(req.agent, target, 'request.agent agrees with scoped carrier');
        assert.equal(ctx.agents.get(target.session.id), req.agent, 'answerer receives exact active registry identity');
        assert.equal(approval.overrideOf(child.session), 'ask');
        assert.equal(approval.overrideOf(target.session), 'ask');
        assert.equal(states.get(child.session).turnOpen, true);
        assert.equal(states.get(root.session).turnOpen, false, 'No synthetic root turn');
        assert.equal(auditEvents(root.session).length, 0, 'Presentation creates no root audit transaction');
        assert.equal(typeof req.displayReason?.en, 'string');
        if (target !== child) assert.equal(Object.hasOwn(req, 'callId'), false, 'Forwarded child callId is omitted');
        else assert.match(req.callId, /^call-/);
      } catch (error) { faults.push([error]); throw error; }
      presentations.push({ target, req, carrier: this });
      return typeof answer === 'function' ? answer(req, presentations.length) : answer;
    });
  }
  if (answerers) {
    mockAnswerer(root);
    if (intermediate) mockAnswerer(intermediate);
    mockAnswerer(child);
  }
  const w = {
    ctx, root, intermediate, child, approval, gate, gateFiber, allAgents, states, presentations, faults, commands,
    request(label = 'one', options = {}) {
      return approval.request({ agent: child, toolName: 'integration.fake-tool', callId: `call-${label}`,
        reason: `integration reason ${label}`, ...options });
    },
    assertAudit(expectedOutcomes) {
      const events = auditEvents(child.session);
      const asked = events.filter(e => e.type === 'approval/asked');
      const decided = events.filter(e => e.type === 'approval/decided');
      assert.equal(asked.length, expectedOutcomes.length);
      assert.equal(decided.length, expectedOutcomes.length);
      assert.equal(new Set(asked.map(e => e.data.id)).size, asked.length, 'Independent real request ids');
      for (const [index, request] of asked.entries()) {
        assert.equal(request.data.toolName, 'integration.fake-tool');
        assert.match(request.data.callId, /^call-/);
        assert.match(request.data.reason, /^integration reason /);
        const decision = decided.find(e => e.data.id === request.data.id);
        assert.ok(decision, 'Every real asked id has one matching decided id');
        assert.equal(decision.data.outcome, expectedOutcomes[index]);
      }
      assert.equal(auditEvents(root.session).length, 0);
      assert.equal(root.session.events.some(e => e.type === 'turn/start' || e.type === 'turn/end'), false);
      assert.equal(states.get(root.session).turnOpen, false);
      if (intermediate) {
        assert.equal(auditEvents(intermediate.session).length, 0, 'Delegated ancestor receives no audit');
        assert.equal(states.get(intermediate.session).turnOpen, false);
      }
      assert.deepEqual(faults, []);
    },
    async close() {
      await gateFiber.dispose();
      if (intermediate) assert.equal(approval.overrideOf(intermediate.session), 'never');
      assert.equal(approval.overrideOf(child.session), 'never', 'Dispose restores seed policy');
      assert.equal(approval.overrideOf(root.session), 'ask', 'Root policy unchanged');
      for (const scope of scopes) await scope.dispose();
      await approvalFiber.dispose();
      worlds.delete(w);
    },
  };
  worlds.add(w);
  return w;
}

/** Suspend the actual Audit.record at its existing awaited directory readiness.
 * No Audit/ApprovalService/Pipeline method is replaced: once released, actual
 * appendFile writes both the proposed human decision and invalidation record.
 */
function blockActualAudit(w) {
  let entered;
  let release;
  const blocked = new Promise(resolveEntered => { entered = resolveEntered; });
  const barrier = new Promise(resolveBarrier => { release = resolveBarrier; });
  w.gate.audit.ready = { then(resolveReady, rejectReady) {
    entered();
    return barrier.then(resolveReady, rejectReady);
  } };
  return { blocked, release };
}

try {
  for (const [label, answer, expected] of [
    ['allowed', 'allowed-once', 'allowed-once'],
    ['rejected', 'rejected', 'rejected'],
    ['cancelled answer', 'cancelled', 'rejected'],
    ['unavailable answer', 'unavailable', 'rejected'],
    ['throwing answer', () => { throw new Error('Mock human transport failure'); }, 'rejected'],
    ['invalid string answer', 'allow-everything', 'rejected'],
    ['invalid object answer', { outcome: 'allowed-once' }, 'rejected'],
  ]) {
    await test(`root CLOSED / child OPEN: ${label}; only child real audit pair`, async () => {
      const w = await world({ answer });
      try {
        assert.equal(await bounded(w.request(label), label), expected);
        assert.equal(w.presentations.length, 1, 'Exactly one root presentation, no child answerer bypass');
        assert.equal(w.presentations[0].target, w.root);
        assert.match(w.presentations[0].req.reason, /subagent.*integration\.fake-tool.*integration reason/);
        w.assertAudit([expected]);
      } finally { await w.close(); }
    });
  }
  await test('no answerer composed fails closed with real child audit pair', async () => {
    const w = await world({ answerers: false });
    try {
      assert.equal(await w.request('missing'), 'rejected');
      assert.equal(w.presentations.length, 0);
      w.assertAudit(['rejected']);
    } finally { await w.close(); }
  });
  await test('self mode reaches child scoped answerer, keeps callId, no root audit', async () => {
    const w = await world({ mode: 'self' });
    try {
      assert.equal(await w.request('self'), 'allowed-once');
      assert.equal(w.presentations.length, 1);
      assert.equal(w.presentations[0].target, w.child);
      assert.equal(w.presentations[0].req.callId, 'call-self');
      w.assertAudit(['allowed-once']);
    } finally { await w.close(); }
  });
  await test('concurrent same-child requests each route to root (no session-busy bypass)', async () => {
    let firstShown;
    const shown = new Promise(resolveShown => { firstShown = resolveShown; });
    let releaseFirst;
    const firstAnswer = new Promise(resolveAnswer => { releaseFirst = resolveAnswer; });
    const w = await world({ answer: (_req, count) => {
      if (count === 1) { firstShown(); return firstAnswer; }
      return 'rejected';
    } });
    try {
      const one = w.request('concurrent-one');
      await bounded(shown, 'first root card');
      const two = w.request('concurrent-two');
      await tick();
      assert.equal(auditEvents(w.child.session).filter(e => e.type === 'approval/asked').length, 2);
      assert.equal(w.presentations.length, 1, 'Second child request queues while first root presentation is pending');
      assert.equal(w.gate.gate.isBusy(w.child.session.id), true);
      releaseFirst('allowed-once');
      assert.deepEqual(await bounded(Promise.all([one, two]), 'both concurrent approvals'), ['allowed-once', 'rejected']);
      assert.equal(w.presentations.length, 2);
      assert.ok(w.presentations.every(p => p.target === w.root));
      assert.notEqual(w.presentations[0].req, w.presentations[1].req, 'Forwarding marker is per request identity');
      w.assertAudit(['allowed-once', 'rejected']);
    } finally { releaseFirst('rejected'); await w.close(); }
  });
  for (const which of ['root', 'child']) {
    await test(`${which} never policy denies without a prompt (source AND target policy checked)`, async () => {
      const w = await world();
      try {
        w.approval.setPolicy(w[which], 'never');
        assert.equal(await w.request(`never-${which}`), 'rejected');
        assert.equal(w.presentations.length, 0);
        w.assertAudit(['rejected']);
      } finally {
        if (which === 'root') w.approval.setPolicy(w.root, 'ask');
        await w.close();
      }
    });
  }
  await test('request signal cancellation reaches active root presentation and audits cancelled only on child', async () => {
    let notifyShown;
    const shown = new Promise(resolveShown => { notifyShown = resolveShown; });
    const w = await world({ answer: req => new Promise(resolveAnswer => {
      req.signal.addEventListener('abort', () => resolveAnswer('cancelled'), { once: true });
      notifyShown();
    }) });
    try {
      const controller = new AbortController();
      const pending = w.request('abort-active', { signal: controller.signal });
      await bounded(shown, 'root presentation before abort');
      controller.abort();
      assert.equal(await bounded(pending, 'real ApprovalService cancellation'), 'cancelled');
      await bounded(w.gate.queue.tail, 'cancelled presentation queue drainage');
      assert.equal(w.presentations.length, 1);
      assert.equal(w.presentations[0].req.signal.aborted, true);
      w.assertAudit(['cancelled']);
    } finally { await w.close(); }
  });
  await test('root presentation timeout aborts transport and fails closed on original child transaction', async () => {
    let aborted = false;
    const w = await world({ answer: req => new Promise(resolveAnswer => {
      req.signal.addEventListener('abort', () => { aborted = true; resolveAnswer('allowed-once'); }, { once: true });
    }) });
    try {
      w.gate.config.humanTimeoutMs = 20;
      assert.equal(await bounded(w.request('timeout'), 'human timeout'), 'rejected');
      assert.equal(aborted, true, 'Timed-out transport receives cancellation; its late grant cannot win');
      assert.equal(w.presentations.length, 1);
      w.assertAudit(['rejected']);
    } finally { await w.close(); }
  });
  for (const which of ['root', 'child']) {
    await test(`${which} changes to never while human answers: late grant is rejected`, async () => {
      let current;
      const w = await world({ answer: () => {
        current.approval.setPolicy(current[which], 'never');
        return 'allowed-once';
      } });
      current = w;
      try {
        assert.equal(await w.request(`changed-${which}`), 'rejected');
        assert.equal(w.presentations.length, 1);
        w.assertAudit(['rejected']);
      } finally {
        if (which === 'root') w.approval.setPolicy(w.root, 'ask');
        await w.close();
      }
    });
  }
  await test('stale source Agent identity rejected even when registry replacement has same session id', async () => {
    const w = await world();
    try {
      w.allAgents.set(w.child.session.id, { ...w.child });
      assert.equal(await w.request('stale-source'), 'rejected');
      assert.equal(w.presentations.length, 0);
      w.assertAudit(['rejected']);
    } finally { w.allAgents.set(w.child.session.id, w.child); await w.close(); }
  });
  await test('stale target Agent identity rejected even when replacement has same session id', async () => {
    const w = await world();
    try {
      w.gate.registerTarget('stale', () => ({ agent: { ...w.root }, path: 'stale' }));
      w.gate.config.forwardTo = 'stale';
      assert.equal(await w.request('stale'), 'rejected');
      assert.equal(w.presentations.length, 0);
      w.assertAudit(['rejected']);
    } finally { await w.close(); }
  });
  for (const action of ['root never', 'child never', 'plugin disposal', 'target replacement', 'target removal', 'source replacement', 'source removal', 'request cancellation', '/off']) {
    await test(`allowed answer blocked in real audit: ${action} invalidates grant`, async () => {
      const w = await world();
      const audit = blockActualAudit(w);
      const controller = new AbortController();
      let waterfallFinished;
      const finished = new Promise(resolveFinished => { waterfallFinished = resolveFinished; });
      const callId = `call-audit-${action}`;
      // Observe completion of the original real Cordis waterfall, not just the
      // real ApprovalService signal race (which may settle before journaling).
      const removeObserver = w.ctx.on('approval/request', function(req, next) {
        const result = next();
        if (req.agent === w.child && req.callId === callId) {
          return Promise.resolve(result).finally(waterfallFinished);
        }
        return result;
      }, { prepend: true });
      let pending;
      try {
        let settled = false;
        pending = w.request(`audit-${action}`, { signal: controller.signal });
        pending.then(() => { settled = true; }, () => { settled = true; });
        await bounded(audit.blocked, 'actual Audit.record readiness barrier');
        assert.equal(w.presentations.length, 1);
        assert.equal(w.presentations[0].target, w.root);
        assert.equal(settled, false, 'Human allowed-once has not completed original approval before audit');
        assert.equal(auditEvents(w.child.session).filter(e => e.type === 'approval/decided').length, 0);
        if (action === 'root never') w.approval.setPolicy(w.root, 'never');
        else if (action === 'child never') w.approval.setPolicy(w.child, 'never');
        else if (action === 'plugin disposal') await w.gateFiber.dispose();
        else if (action === 'target replacement') w.allAgents.set(w.root.session.id, { ...w.root });
        else if (action === 'target removal') w.allAgents.delete(w.root.session.id);
        else if (action === 'source replacement') w.allAgents.set(w.child.session.id, { ...w.child });
        else if (action === 'source removal') w.allAgents.delete(w.child.session.id);
        else if (action === 'request cancellation') controller.abort();
        else if (action === '/off') {
          assert.match(w.commands.get('subagent-gate').handler({ rawInput: 'off' }).text, /OFF/);
        }
        audit.release();
        const expected = action === 'request cancellation' ? 'cancelled' : 'rejected';
        assert.equal(await bounded(pending, 'audit-invalidated original approval'), expected);
        await bounded(finished, 'real gate waterfall finished after audit release');
        w.assertAudit([expected]);
        const journal = (await readFile(join(configDir, 'audit.jsonl'), 'utf8')).trim().split(/\r?\n/).map(line => JSON.parse(line))
          .filter(entry => entry.sessionId === w.child.session.id);
        assert.deepEqual(journal.map(entry => [entry.kind, entry.decision]), [['human', 'allow'], ['invalidated', 'deny']],
          'Actual plugin journal records allowed proposal followed by stale-grant invalidation');
        assert.equal(w.presentations.length, 1, 'Invalidation never re-prompts');
      } finally {
        audit.release();
        if (pending) await bounded(pending, 'finish regression request cleanup');
        removeObserver();
        w.allAgents.set(w.root.session.id, w.root);
        w.allAgents.set(w.child.session.id, w.child);
        if (w.approval.overrideOf(w.root.session) !== 'ask') w.approval.setPolicy(w.root, 'ask');
        await w.close();
      }
    });
  }
  await test('missing human root with live intermediate delegated ancestor rejects without any presentation', async () => {
    const w = await world({ withIntermediate: true });
    try {
      assert.equal(w.approval.overrideOf(w.intermediate.session), 'ask');
      assert.equal(w.gate.coverage.rootAgent(w.child.session), w.root);
      w.allAgents.delete(w.root.session.id);
      assert.equal(await w.request('missing-human-root'), 'rejected');
      assert.equal(w.presentations.length, 0, 'Do not substitute a live delegated ancestor for the missing human root');
      assert.equal(w.gate.coverage.rootAgent(w.child.session), undefined);
      assert.deepEqual(w.gate.coverage.ancestors(w.child.session), [w.intermediate]);
      w.assertAudit(['rejected']);
    } finally { w.allAgents.set(w.root.session.id, w.root); await w.close(); }
  });
  await test('off/on restores never/rearms ask; disposal removes gate listener and restores never', async () => {
    const w = await world();
    try {
      const command = w.commands.get('subagent-gate');
      assert.ok(command);
      assert.match(command.handler({ rawInput: 'off' }).text, /OFF/);
      assert.equal(w.approval.overrideOf(w.child.session), 'never');
      assert.equal(await w.request('off'), 'rejected');
      assert.equal(w.presentations.length, 0);
      assert.match(command.handler({ rawInput: 'on' }).text, /ON/);
      assert.equal(w.approval.overrideOf(w.child.session), 'ask');
      assert.equal(await w.request('on'), 'allowed-once');
      assert.equal(w.presentations.length, 1);
      w.assertAudit(['rejected', 'allowed-once']);
      await w.gateFiber.dispose();
      assert.equal(w.gateFiber.uid, null);
      assert.equal((w.ctx.events._hooks['approval/request'] ?? []).some(hook => hook.ctx.fiber === w.gateFiber), false,
        'Cordis actually removed the disposed gate waterfall listener');
      assert.equal(w.approval.overrideOf(w.child.session), 'never');
      assert.equal(await w.request('disposed'), 'rejected');
      assert.equal(w.presentations.length, 1);
      w.assertAudit(['rejected', 'allowed-once', 'rejected']);
    } finally { await w.close(); }
  });
  await test('persisted disabled startup keeps command registered; /on arms existing delegated child', async () => {
    const w = await world({ initiallyEnabled: false });
    try {
      assert.equal(w.gate.config.enabled, false);
      assert.equal(w.approval.overrideOf(w.child.session), 'never');
      assert.equal(w.gate.armed.size, 0);
      const command = w.commands.get('subagent-gate');
      assert.ok(command, 'Persisted OFF must not hide the command needed to enable the gate');
      assert.match(command.handler({ rawInput: 'status' }).text, /OFF/);
      assert.equal(await w.request('startup-off'), 'rejected');
      assert.equal(w.presentations.length, 0);
      assert.match(command.handler({ rawInput: 'on' }).text, /ON/);
      assert.equal(w.approval.overrideOf(w.child.session), 'ask');
      assert.equal(w.gate.armed.has(w.child.session.id), true);
      assert.equal(await w.request('startup-on'), 'allowed-once');
      assert.equal(w.presentations.length, 1);
      assert.equal(w.presentations[0].target, w.root);
      w.assertAudit(['rejected', 'allowed-once']);
    } finally { await w.close(); }
  });
  await test('real ApprovalService refuses an idle root request, proving fixture detects duplicate-root transaction', async () => {
    const w = await world();
    try {
      await assert.rejects(w.approval.request({ agent: w.root, toolName: 'must-not-be-called' }), /outside an open turn/);
      assert.equal(auditEvents(w.root.session).length, 0);
      assert.equal(w.presentations.length, 0);
      w.assertAudit([]);
    } finally { await w.close(); }
  });
} finally {
  for (const w of worlds) {
    try { await w.close(); } catch (error) { fail++; console.error('FAIL cleanup', error); }
  }
  // Command saveConfig is intentionally fire-and-forget in production. Let its
  // already-issued I/O complete before removing this harness-owned temp tree.
  await tick();
  if (oldHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = oldHome;
  hook.deregister();
  await rm(isolatedHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
console.log(`\nIntegration result: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
