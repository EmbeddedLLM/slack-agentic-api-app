import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const quote = value => '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%') + '"';
console.log(`[Unit]
Description=Slack assistant using Agentic API WebSockets
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${quote(root)}
ExecStart=${quote(process.execPath)} scripts/start-app.js
Environment=NODE_ENV=production
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
UMask=0077

[Install]
WantedBy=default.target`);
