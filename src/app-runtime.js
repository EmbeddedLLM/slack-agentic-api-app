import dotenv from 'dotenv';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export function gatewayCommand(root, inherited = process.env) {
  let file = {};
  try { file = dotenv.parse(readFileSync(path.join(root, '.env.gateway'))); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const env = Object.fromEntries(Object.entries({ ...file, ...inherited }).filter(([key]) => !key.startsWith('SLACK_')));
  const command = path.join(root, '.runtime/agentic-api/target/release/agentic-server');
  if (!existsSync(command)) throw new Error('Install the source gateway first: npm run gateway:install');
  env.AGENTIC_API_HOME ||= path.join(root, '.runtime/gateway-data');
  env.AGENTIC_WEB_SEARCH_PROVIDER ||= 'you';
  env.AGENTIC_CODE_INTERPRETER_ENABLED ||= 'true';
  env.RUST_LOG ||= 'info';
  return { command, env, args: [
    '--llm-api-base', env.LLM_API_BASE || 'http://127.0.0.1:5050',
    '--gateway-host', env.GATEWAY_HOST || '127.0.0.1',
    '--gateway-port', env.GATEWAY_PORT || '9000',
  ] };
}

export function runtimeSettings(root, env) {
  const url = new URL(env.AGENTIC_WS_URL || 'ws://127.0.0.1:9000/v1/responses');
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/v1/responses') {
    throw new Error('AGENTIC_WS_URL must be a ws:// or wss:// URL ending in /v1/responses, without credentials or a query.');
  }
  const managed = !/^(false|0|no|off)$/i.test(env.MANAGE_GATEWAY || 'true');
  const gateway = managed ? gatewayCommand(root, env) : null;
  if (gateway) {
    const hosts = ['localhost', '127.0.0.1', '[::1]'];
    if (url.protocol !== 'ws:' || !hosts.includes(url.hostname) ||
        !['localhost', '127.0.0.1', '::1', '0.0.0.0', '::'].includes(gateway.env.GATEWAY_HOST || '127.0.0.1')) {
      throw new Error('Managed gateway mode requires a local ws:// endpoint. For an external gateway, set MANAGE_GATEWAY=false.');
    }
    if (Number(url.port || 80) !== Number(gateway.env.GATEWAY_PORT || 9000)) {
      throw new Error('AGENTIC_WS_URL and GATEWAY_PORT in .env.gateway must use the same port.');
    }
    mkdirSync(gateway.env.AGENTIC_API_HOME, { recursive: true, mode: 0o700 });
  }
  const timeoutMs = Number(env.GATEWAY_STARTUP_TIMEOUT_MS || 120_000);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000) throw new Error('GATEWAY_STARTUP_TIMEOUT_MS must be at least 1000.');
  url.protocol = url.protocol === 'ws:' ? 'http:' : 'https:';
  url.pathname = '/ready';
  return { gateway, readinessUrl: url.href, timeoutMs,
    bot: { command: process.execPath, args: [path.join(root, 'index.js')], env }, cwd: root };
}

export function portIsOpen(url) {
  const endpoint = new URL(url);
  return new Promise(resolve => {
    const socket = net.connect({ host: endpoint.hostname.replace(/^\[|\]$/g, ''), port: Number(endpoint.port || (endpoint.protocol === 'https:' ? 443 : 80)) });
    const done = open => { socket.destroy(); resolve(open); };
    socket.setTimeout(1000, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

function launch(spec, cwd, log, name) {
  const child = spawn(spec.command, spec.args, { cwd, env: spec.env, stdio: 'inherit', detached: process.platform !== 'win32' });
  const done = new Promise(resolve => {
    child.once('error', error => resolve({ name, error: error.code || 'spawn failed' }));
    child.once('exit', (code, signal) => resolve({ name, code, signal }));
  });
  log(`${name} started (pid ${child.pid || 'unavailable'}).`);
  return { child, done, name };
}

async function stopProcess(proc, graceMs) {
  if (!proc?.child.pid) return;
  const kill = signal => {
    try {
      if (process.platform === 'win32') proc.child.kill(signal);
      else process.kill(-proc.child.pid, signal); // includes gateway tool subprocesses
    } catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  kill('SIGTERM');
  const timer = new AbortController();
  await Promise.race([proc.done, delay(graceMs, null, { signal: timer.signal }).catch(() => {})]);
  timer.abort();
  kill('SIGKILL'); // also clean up any grandchildren left after the parent exited
  await proc.done;
}

async function waitReady(url, gateway, signal, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!signal.aborted && Date.now() < deadline) {
    if (gateway && (!gateway.child.pid || gateway.child.exitCode !== null || gateway.child.signalCode !== null)) throw new Error('Gateway exited before it became ready. Check its log above.');
    try {
      const response = await fetch(url, { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(1500)]) });
      await response.body?.cancel();
      if (response.ok) return;
    } catch { /* Startup can take time, particularly when loading the interpreter. */ }
    await delay(300, null, { signal }).catch(() => {});
  }
  if (!signal.aborted) throw new Error(`Gateway did not become ready within ${timeoutMs / 1000}s. Check LLM_API_BASE, the model server, and the gateway log.`);
}

// One supervisor owns both processes; no inference requests are replayed after
// a crash. Parent monitoring handles a Slack CLI exit that sends no signal.
export async function supervise({ gateway, bot, readinessUrl, cwd, timeoutMs = 120_000,
  graceMs = 5000, restartDelayMs = 2000, maxRestarts = 3,
  log = text => console.log(`[app-runtime] ${text}`) }) {
  const abort = new AbortController();
  let stopReason = '';
  const stop = reason => { stopReason ||= reason; abort.abort(); };
  const handlers = new Map(['SIGINT', 'SIGTERM', 'SIGHUP'].map(signal => [signal, () => stop(signal)]));
  for (const [signal, handler] of handlers) process.on(signal, handler);
  const parentPid = process.ppid;
  const parentWatch = setInterval(() => { if (parentPid > 1 && process.ppid !== parentPid) stop('launcher exited'); }, 500);
  parentWatch.unref();
  const stopped = new Promise(resolve => abort.signal.addEventListener('abort', () => resolve(null), { once: true }));
  const restarts = [];
  try {
    while (!abort.signal.aborted) {
      let gatewayProcess;
      let botProcess;
      try {
        if (gateway && await portIsOpen(readinessUrl)) throw new Error('Gateway port is already in use. Stop the separately running gateway, or set MANAGE_GATEWAY=false to use it without managing it.');
        if (abort.signal.aborted) break;
        if (gateway) gatewayProcess = launch(gateway, cwd, log, 'Gateway');
        log('Waiting for gateway and model readiness…');
        await waitReady(readinessUrl, gatewayProcess, abort.signal, timeoutMs);
        if (abort.signal.aborted) break;
        log('Gateway ready. Starting Slack bot…');
        botProcess = launch(bot, cwd, log, 'Slack bot');
        const ended = await Promise.race([stopped, botProcess.done, ...(gatewayProcess ? [gatewayProcess.done] : [])]);
        if (ended && !abort.signal.aborted) {
          log(`${ended.name} exited (${ended.error || ended.signal || ended.code}).`);
          const now = Date.now();
          while (restarts.length && restarts[0] < now - 60_000) restarts.shift();
          if (restarts.length >= maxRestarts) throw new Error('Too many process exits within one minute; stopped to avoid a restart loop.');
          restarts.push(now);
        }
      } finally {
        // Keep the gateway up until the bot has cancelled its in-flight work.
        await stopProcess(botProcess, graceMs);
        await stopProcess(gatewayProcess, graceMs);
      }
      if (!abort.signal.aborted) {
        log('Restarting gateway and bot; interrupted requests will not be retried.');
        await delay(restartDelayMs, null, { signal: abort.signal }).catch(() => {});
      }
    }
    log(`Stopped (${stopReason || 'shutdown'}); child processes cleaned up.`);
  } finally {
    clearInterval(parentWatch);
    for (const [signal, handler] of handlers) process.off(signal, handler);
  }
}
