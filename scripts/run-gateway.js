import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gatewayCommand } from '../src/app-runtime.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const spec = gatewayCommand(root);
mkdirSync(spec.env.AGENTIC_API_HOME, { recursive: true, mode: 0o700 });
const child = spawn(spec.command, spec.args, { env: spec.env, cwd: root, stdio: 'inherit' });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
