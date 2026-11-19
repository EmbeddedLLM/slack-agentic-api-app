import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimeSettings, supervise } from '../src/app-runtime.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
dotenv.config({ path: path.join(root, '.env') });
try {
  if (!process.env.SLACK_BOT_TOKEN || !process.env.SLACK_APP_TOKEN) {
    throw new Error('Start with slack run to inject Slack credentials, or configure SLACK_BOT_TOKEN and SLACK_APP_TOKEN in .env for npm start.');
  }
  await supervise(runtimeSettings(root, process.env));
} catch (error) {
  console.error(`[app-runtime] ${error.message}`);
  process.exitCode = 1;
}
