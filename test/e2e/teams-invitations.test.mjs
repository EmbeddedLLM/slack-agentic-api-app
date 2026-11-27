import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tenantId, clientId } from '../helpers/msal.js';
import { startBot, ok, J, until, finish } from './harness.mjs';

const dir = mkdtempSync(path.join(os.tmpdir(), 'teams-invites-e2e-'));
const graphCalls = [];
let linkReady = true;
globalThis.fetch = async (url, options) => {
  if (!url.startsWith('https://graph.microsoft.com/v1.0/me/')) throw new Error('Unexpected network call');
  graphCalls.push({ url, method: options.method, body: options.body && JSON.parse(options.body) });
  if (url.includes('/calendar?')) return Response.json({ allowedOnlineMeetingProviders: ['teamsForBusiness'] });
  return Response.json({ id: 'event-1', isOnlineMeeting: true, onlineMeetingProvider: 'teamsForBusiness',
    onlineMeeting: linkReady ? { joinUrl: 'https://teams.microsoft.com/l/meetup-join/verified-invitation' } : null }, { status: options.method === 'POST' ? 201 : 200 });
};
let finishLogin;
globalThis.__msalDeviceLogin = () => new Promise(resolve => { finishLogin = resolve; });
const bot = await startBot({ TEAMS_ENABLED: 'true', TEAMS_ORGANIZER_MODE: 'per_user', TEAMS_STATE_DIR: dir, TEAMS_TENANT_ID: tenantId, TEAMS_CLIENT_ID: clientId });
bot.users.UALICE = { real_name: 'Alice Example', profile: { email: 'alice@example.org' } };
bot.setMode('teams-invites');
const request = bot.mention('UMEM', 'create a Teams call now for 30 minutes and invite <@UALICE> and bob@example.org');
await until(() => bot.ephemerals().some(text => text.includes('TESTCODE')));
ok(graphCalls.length === 0, 'no calendar write or invitations before private Microsoft sign-in');
finishLogin();
await request;
globalThis.__msalDeviceLogin = undefined;
const tool = bot.gateway.requests[0].tools.find(t => t.name === 'create_teams_meeting');
ok(tool.parameters.required.includes('attendees') && /email invitations/.test(tool.description), 'WS function schema guides the model to pass invitees');
ok(bot.agentCalls()[0].prompt.includes('@Alice Example (UALICE)'), 'current Slack mentions preserve exact IDs for function arguments');
const output = JSON.parse(bot.gateway.requests[1].input.find(i => i.type === 'function_call_output').output);
ok(output.ok && output.invitations_sent && output.attendees.length === 2, 'calendar and invite receipt continues over the same agent WebSocket');
ok(bot.gateway.connections.length === 1, 'sign-in and invitations use the existing inference connection');
const post = graphCalls.find(c => c.method === 'POST');
ok(post.body.attendees[0].emailAddress.address === 'alice@example.org' && post.body.attendees[1].emailAddress.address === 'bob@example.org', 'resolved Slack email and explicit email are both passed to Microsoft');
const final = bot.calls.filter(c => c.m === 'chat.update').at(-1).a;
ok(final.thread_ts === undefined && J(final).includes(output.join_url) && J(final).includes('alice@example.org'), 'final placeholder update includes confirmed link and invitation recipients');
ok(bot.calls.filter(c => c.m === 'chat.postMessage').every(c => c.a.thread_ts === bot.lastTs), 'meeting receipt stays in the request thread');
ok(!J(bot.gateway.requests).includes('TESTCODE') && !J(bot.gateway.requests).includes('test-microsoft-access-token'), 'Microsoft sign-in code and token never reach the model');

bot.users.UALICE.profile = {};
const before = graphCalls.filter(c => c.method === 'POST').length;
await bot.mention('UMEM', 'create a meeting and invite <@UALICE> and bob@example.org');
ok(graphCalls.filter(c => c.method === 'POST').length === before, 'one missing email prevents inviting a partial attendee list');
ok(/email address/.test(bot.calls.filter(c => c.m === 'chat.update').at(-1).a.text), 'requester gets an actionable missing-email response');
bot.users.UALICE.profile.email = 'alice@example.org';
bot.setMode('teams-invites-failure');
await bot.mention('UMEM', 'create a call and invite <@UALICE> and bob@example.org');
const failedModel = bot.calls.filter(c => c.m === 'chat.update').at(-1).a.text;
ok(failedModel.includes('verified-invitation') && failedModel.includes('Invitations submitted') && !failedModel.includes('No invitation'), 'model failure preserves both real link and invitation receipt');

bot.setMode('teams-invites');
linkReady = false;
await bot.mention('UMEM', 'create a call and invite <@UALICE> and bob@example.org');
const incomplete = J(bot.calls.filter(c => c.m === 'chat.update').at(-1).a);
ok(/Do not create another event/.test(incomplete) && !/The meeting is ready/.test(incomplete), 'calendar partial success overrides optimistic model output without inventing a join link');
rmSync(dir, { recursive: true, force: true });
finish();
