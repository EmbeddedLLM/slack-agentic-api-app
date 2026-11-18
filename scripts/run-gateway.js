import dotenv from 'dotenv';
import { spawn } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const config = dotenv.config({ path: path.join(root, '.env.gateway') });
if (config.error && config.error.code !== 'ENOENT') throw config.error;
const binary = path.join(root, '.runtime/agentic-api/target/release/agentic-server');
if (!existsSync(binary)) throw new Error('Install the source gateway first: npm run gateway:install');
const gatewayEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('SLACK_')));
gatewayEnv.AGENTIC_API_HOME ||= path.join(root, '.runtime/gateway-data');
gatewayEnv.AGENTIC_WEB_SEARCH_PROVIDER ||= 'you';
gatewayEnv.AGENTIC_CODE_INTERPRETER_ENABLED ||= 'true';
gatewayEnv.RUST_LOG ||= 'info';
mkdirSync(gatewayEnv.AGENTIC_API_HOME, { recursive: true, mode: 0o700 });
const child = spawn(binary, [
  '--llm-api-base', gatewayEnv.LLM_API_BASE || 'http://127.0.0.1:5050',
  '--gateway-host', gatewayEnv.GATEWAY_HOST || '127.0.0.1',
  '--gateway-port', gatewayEnv.GATEWAY_PORT || '9000',
], { env: gatewayEnv, cwd: root, stdio: 'inherit' });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
