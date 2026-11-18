// Use the project's manifest explicitly instead of recursively finding a file
// in an unrelated source checkout under .runtime/.
import { existsSync, readFileSync } from 'node:fs';
import { getProtocol } from '@slack/cli-hooks/src/protocols.js';

const perApp = new URL('../.slack/manifest.local.json', import.meta.url);
const source = existsSync(perApp) ? perApp : new URL('../slack-app-manifest.json', import.meta.url);
const manifest = JSON.parse(readFileSync(source, 'utf8'));
getProtocol(process.argv.slice(2)).respond(JSON.stringify(manifest));
