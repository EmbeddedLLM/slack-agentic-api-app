import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tenantId, clientId } from '../helpers/msal.js';
import { startBot, ok, J, until, finish } from './harness.mjs';

const dir = mkdtempSync(path.join(os.tmpdir(), 'teams-signin-e2e-'));
const graphCalls = [];
globalThis.fetch = async (url, options) => {
  if (url !== 'https://graph.microsoft.com/v1.0/me/onlineMeetings/createOrGet') throw new Error('Unexpected network call');
  const body = JSON.parse(options.body);
  graphCalls.push(body);
  return Response.json({ id: body.externalId, subject: body.subject, startDateTime: body.startDateTime, endDateTime: body.endDateTime,
    joinWebUrl: `https://teams.microsoft.com/l/meetup-join/${body.externalId}` });
};
let finishLogin;
globalThis.__msalDeviceLogin = () => new Promise(resolve => { finishLogin = resolve; });
const bot = await startBot({ TEAMS_ENABLED: 'true', TEAMS_ORGANIZER_MODE: 'per_user', TEAMS_STATE_DIR: dir, TEAMS_TENANT_ID: tenantId, TEAMS_CLIENT_ID: clientId });
bot.setMode('teams');
const request = bot.mention('UMEM', 'create a Teams meeting for 30 minutes now');
await until(() => bot.ephemerals().some(text => text.includes('TESTCODE')));
const loginMessage = bot.calls.find(c => c.m === 'chat.postEphemeral' && c.a.text.includes('TESTCODE'));
ok(loginMessage.a.user === 'UMEM' && loginMessage.a.thread_ts === bot.lastTs, 'sign-in instructions are private to the requester in the original thread');
ok(graphCalls.length === 0, 'meeting is not created until Microsoft sign-in completes');
finishLogin();
await request;
ok(graphCalls.length === 1, 'successful sign-in automatically creates the pending meeting');
ok(!J(bot.gateway.requests).includes('TESTCODE') && !J(bot.gateway.requests).includes('test-microsoft-access-token'), 'login code and Microsoft token never enter model requests');
ok(!J(bot.calls.filter(c => c.m === 'chat.postMessage' || c.m === 'chat.update')).includes('TESTCODE'), 'login code never appears in public thread messages');
ok(J(bot.calls.filter(c => c.m === 'chat.update').at(-1)).includes('teams.microsoft.com'), 'confirmed meeting link is posted in the thread');
const loginCount = () => bot.calls.filter(c => c.m === 'chat.postEphemeral' && c.a.text.includes('TESTCODE')).length;
await bot.mention('UMEM', 'create another Teams meeting');
ok(graphCalls.length === 2 && loginCount() === 1, 'next meeting reuses only that member’s saved sign-in');

globalThis.__msalDeviceLogin = undefined;
await bot.dm('UADMIN', 'create a Teams meeting');
ok(loginCount() === 2 && readdirSync(path.join(dir, 'users')).length === 2, 'another Slack member signs in separately and has isolated credentials');
await bot.mention('UMEM', 'teams disconnect');
await bot.mention('UMEM', 'create a Teams meeting');
ok(loginCount() === 3, 'disconnect removes only the requester’s saved sign-in');
const before = graphCalls.length;
await bot.mention('UMEM', 'teams disconnect');
globalThis.__msalDeviceLogin = async () => { throw new Error('Microsoft denied test login'); };
await bot.mention('UMEM', 'create a Teams meeting');
ok(graphCalls.length === before, 'failed Microsoft sign-in creates no meeting');
ok(J(bot.calls.filter(c => c.m === 'chat.update').at(-1)).includes('meeting was not confirmed'), 'an optimistic model answer cannot claim success after failed sign-in');

globalThis.__msalDeviceLogin = () => new Promise(resolve => { finishLogin = resolve; });
const cancelled = bot.mention('UMEM', 'create a Teams meeting');
await until(() => loginCount() === 5);
const pending = bot.calls.findLast(c => c.m === 'chat.postMessage' && c.a.blocks?.some(b => b.elements?.some(e => e.action_id === 'cancel_job')));
const cancelValue = pending.a.blocks.flatMap(b => b.elements || []).find(e => e.action_id === 'cancel_job').value;
await bot.click('cancel_job', cancelValue, 'UMEM');
finishLogin();
await cancelled;
ok(graphCalls.length === before, 'cancelling while signing in prevents meeting creation');
globalThis.__msalDeviceLogin = undefined;
rmSync(dir, { recursive: true, force: true });
finish();
