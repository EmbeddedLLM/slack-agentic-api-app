import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { gatewayCommand, portIsOpen, runtimeSettings } from '../src/app-runtime.js';

async function until(fn, timeout = 7000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await fn(); if (result) return result; await delay(30); }
  throw new Error('Timed out waiting for runtime lifecycle');
}
const alive = pid => {
  try {
    process.kill(pid, 0);
    if (process.platform === 'linux' && readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].startsWith('Z')) return false;
    return true;
  } catch { return false; }
};

async function fixture(t, options = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'app-runtime-test-'));
  const probe = createServer((_, res) => { res.writeHead(200); res.end('ready'); });
  probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port;
  if (!options.external && !options.occupied) await new Promise(resolve => probe.close(resolve));
  const records = path.join(dir, 'events.jsonl');
  const worker = path.join(dir, 'worker.mjs');
  writeFileSync(worker, `
    import { appendFileSync } from 'node:fs';
    import { createServer } from 'node:http';
    const role = process.argv[2];
    const record = event => appendFileSync(${JSON.stringify(records)}, JSON.stringify({role, event, pid:process.pid, time:Date.now()})+'\\n');
    record('start');
    let server;
    if (role === 'gateway') {
      const readyAt = Date.now() + ${options.readyDelay ?? 250};
      server = createServer((_, res) => { const ready=Date.now()>=readyAt; if(ready) record('ready'); res.writeHead(ready ? 200 : 503); res.end(); });
      server.listen(${port}, '127.0.0.1');
    } else setInterval(() => {}, 1000);
    process.on('SIGTERM', () => { record('stop'); if(role==='bot' && ${Boolean(options.stubborn)}) return; server?.close(); process.exit(0); });
  `);
  const command = role => ({ command: process.execPath, args: [worker, role], env: { PATH: process.env.PATH } });
  const settings = { gateway: options.external ? null : command('gateway'), bot: command('bot'),
    readinessUrl: `http://127.0.0.1:${port}/ready`, cwd: dir, timeoutMs: options.timeoutMs ?? 2000, graceMs: 150, restartDelayMs: 40 };
  const entry = path.join(dir, 'supervisor.mjs');
  writeFileSync(entry, `import { supervise } from ${JSON.stringify(new URL('../src/app-runtime.js', import.meta.url).href)};
    try { await supervise(${JSON.stringify(settings)}); } catch(error) { console.error(error.message); process.exitCode=1; }`);
  let child;
  let supervisorPid;
  if (options.parent) {
    const parent = path.join(dir, 'parent.mjs');
    writeFileSync(parent, `import { spawn } from 'node:child_process'; const child=spawn(process.execPath,[${JSON.stringify(entry)}],{stdio:'inherit'}); console.log('SUPERVISOR_PID='+child.pid); setInterval(()=>{},1000);`);
    child = spawn(process.execPath, [parent]);
  } else child = spawn(process.execPath, [entry]);
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; const match=/SUPERVISOR_PID=(\d+)/.exec(output); if(match) supervisorPid=Number(match[1]); });
  child.stderr.on('data', chunk => { output += chunk; });
  const done = once(child, 'exit');
  const events = () => existsSync(records) ? readFileSync(records, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  const startEvents = role => events().filter(e => e.role === role && e.event === 'start');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await done;
    if (supervisorPid && alive(supervisorPid)) { process.kill(supervisorPid, 'SIGTERM'); await until(() => !alive(supervisorPid)); }
    for (const e of events()) if (alive(e.pid)) { try { process.kill(-e.pid, 'SIGKILL'); } catch {} }
    if (probe.listening) await new Promise(resolve => probe.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });
  return { child, done, events, startEvents, settings, output: () => output, probe };
}

test('configuration keeps Slack credentials out of the gateway and gateway secrets out of the bot', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'app-runtime-config-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, '.runtime/agentic-api/target/release'), { recursive: true });
  writeFileSync(path.join(root, '.runtime/agentic-api/target/release/agentic-server'), 'fixture');
  writeFileSync(path.join(root, '.env.gateway'), 'YOU_API_KEY=test-you-secret\nGATEWAY_PORT=9002\nLLM_API_BASE=http://127.0.0.1:6767\n');
  const env = { SLACK_APP_TOKEN: 'test-slack', AGENTIC_WS_URL: 'ws://127.0.0.1:9002/v1/responses' };
  const settings = runtimeSettings(root, env);
  assert.equal(settings.gateway.env.SLACK_APP_TOKEN, undefined);
  assert.equal(settings.gateway.env.YOU_API_KEY, 'test-you-secret');
  assert.equal(settings.bot.env.YOU_API_KEY, undefined);
  assert.equal(settings.bot.env.SLACK_APP_TOKEN, 'test-slack');
  assert.equal(settings.readinessUrl, 'http://127.0.0.1:9002/ready');
  assert.throws(() => runtimeSettings(root, { ...env, AGENTIC_WS_URL: 'ws://127.0.0.1:9999/v1/responses' }), /same port/);
  assert.throws(() => runtimeSettings(root, { ...env, AGENTIC_WS_URL: 'wss://example.org/v1/responses' }), /local ws/);
  assert.equal(runtimeSettings(root, { ...env, MANAGE_GATEWAY: 'false', AGENTIC_WS_URL: 'wss://example.org/v1/responses' }).gateway, null);
  assert.equal(gatewayCommand(root, { GATEWAY_PORT: '9010' }).env.GATEWAY_PORT, '9010');
});

test('bot starts only after gateway readiness; shutdown cleans both even if bot ignores SIGTERM', async t => {
  const f = await fixture(t, { stubborn: true });
  await until(() => f.startEvents('bot').length === 1);
  const ready = f.events().find(e => e.event === 'ready');
  assert.ok(ready && ready.time <= f.startEvents('bot')[0].time);
  f.child.kill('SIGINT'); await f.done;
  for (const e of f.events()) assert.equal(alive(e.pid), false);
  assert.equal(await portIsOpen(f.settings.readinessUrl), false);
});

test('gateway crash restarts both processes without leaving the old bot alive', async t => {
  const f = await fixture(t);
  await until(() => f.startEvents('bot').length === 1);
  const firstBot = f.startEvents('bot')[0].pid;
  process.kill(f.startEvents('gateway')[0].pid, 'SIGKILL');
  await until(() => f.startEvents('bot').length === 2);
  assert.equal(alive(firstBot), false);
  assert.equal(f.startEvents('gateway').length, 2);
  f.child.kill('SIGTERM'); await f.done;
  for (const e of f.events()) assert.equal(alive(e.pid), false);
});

test('occupied gateway port fails without starting a bot or touching the listener', async t => {
  const f = await fixture(t, { occupied: true });
  assert.equal((await f.done)[0], 1);
  assert.equal(f.events().length, 0);
  assert.match(f.output(), /already in use/);
  assert.equal(await portIsOpen(f.settings.readinessUrl), true);
});

test('external gateway mode never stops the externally managed listener', async t => {
  const f = await fixture(t, { external: true });
  await until(() => f.startEvents('bot').length === 1);
  f.child.kill('SIGTERM'); await f.done;
  assert.equal(f.startEvents('gateway').length, 0);
  assert.equal(await portIsOpen(f.settings.readinessUrl), true);
});

test('failed readiness stops the gateway without starting Slack', async t => {
  const f = await fixture(t, { readyDelay: 5000, timeoutMs: 200 });
  assert.equal((await f.done)[0], 1);
  assert.equal(f.startEvents('bot').length, 0);
  assert.match(f.output(), /did not become ready/);
  for (const e of f.events()) assert.equal(alive(e.pid), false);
});

test('unexpected launcher-parent exit cleans up both children', { skip: process.platform !== 'linux' }, async t => {
  const f = await fixture(t, { parent: true });
  await until(() => f.startEvents('bot').length === 1);
  f.child.kill('SIGKILL'); await f.done;
  await until(() => f.events().every(e => !alive(e.pid)));
  assert.equal(await portIsOpen(f.settings.readinessUrl), false);
});
