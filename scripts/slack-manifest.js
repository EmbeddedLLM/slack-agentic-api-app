// Use the project's manifest explicitly instead of recursively finding a file
// in an unrelated source checkout under .runtime/.
import { readFileSync } from 'node:fs';
import { getProtocol } from '@slack/cli-hooks/src/protocols.js';

const manifest = JSON.parse(readFileSync(new URL('../slack-app-manifest.json', import.meta.url), 'utf8'));
getProtocol(process.argv.slice(2)).respond(JSON.stringify(manifest));
