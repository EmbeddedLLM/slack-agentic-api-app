import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TeamsMeetings, meetingReply } from '../src/teams-meetings.js';
import { TeamsAccounts } from '../src/teams-accounts.js';

const now = Date.parse('2027-01-01T00:00:00Z');
const args = { subject: 'Design review', starts_at: '2027-01-02T14:00:00+08:00', duration_minutes: 30, attendees: ['UALICE', 'bob@example.org'] };
const raw = JSON.stringify(args);
const event = { id: 'event/1', isOnlineMeeting: true, onlineMeetingProvider: 'teamsForBusiness',
  onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/real-event' } };
function fixture(t, override) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'teams-invites-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const organizer = { homeAccountId: 'organizer', tenantId: 'tenant', clientId: 'client' };
  const auth = { config: { dir }, ready: () => true, organizer: () => organizer, token: async () => ({ accessToken: 'secret-microsoft-token', organizer }) };
  const calls = [], lookups = [];
  const context = { job: { channel: 'C123', user: 'U123', requestTs: '123.456' }, requestText: 'Create meeting with <@UALICE> and bob@example.org', authorize: async () => true,
    client: { users: { info: async ({ user }) => { lookups.push(user); return { ok: true, user: { id: user, profile: { email: 'alice@example.org' } } }; } } } };
  const settings = { now: () => now, fetchImpl: async (url, options) => {
    calls.push({ url, ...options, body: options.body ? JSON.parse(options.body) : undefined });
    const overridden = await override?.(url, options, context);
    if (overridden) return overridden;
    return url.includes('/me/calendar?') ? Response.json({ allowedOnlineMeetingProviders: ['teamsForBusiness'] }) : Response.json(event, { status: options.method === 'POST' ? 201 : 200 });
  } };
  const service = new TeamsMeetings(auth, settings);
  return { auth, context, calls, lookups, settings, service, run: service.handler(context) };
}

test('calendar invitations use verified emails, UTC time and one persisted transaction across concurrent calls/restarts', async t => {
  const f = fixture(t);
  const results = await Promise.all([f.run(raw), f.run(raw), f.run(raw)]);
  assert.ok(results.every(r => r.ok && r.calendar_event_created && r.invitations_sent));
  const posts = f.calls.filter(c => c.method === 'POST');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, 'https://graph.microsoft.com/v1.0/me/events');
  assert.equal(posts[0].body.start.dateTime, '2027-01-02T06:00:00.000');
  assert.equal(posts[0].body.end.dateTime, '2027-01-02T06:30:00.000');
  assert.equal(posts[0].body.start.timeZone, 'UTC');
  assert.deepEqual(posts[0].body.attendees.map(a => a.emailAddress.address), ['alice@example.org', 'bob@example.org']);
  assert.equal(posts[0].body.isOnlineMeeting, true);
  assert.ok(posts[0].body.transactionId);
  assert.equal(posts[0].redirect, 'error');
  assert.deepEqual(f.lookups, ['UALICE']);
  assert.ok(!JSON.stringify(results).includes('secret-microsoft-token'));
  const restarted = new TeamsMeetings(f.auth, f.settings);
  const reused = await restarted.handler(f.context)(JSON.stringify({ ...args, attendees: ['new@example.org'] }));
  assert.equal(reused.reused, true);
  assert.deepEqual(reused.attendees, ['alice@example.org', 'bob@example.org']);
  assert.equal(f.calls.length, 2, 'confirmed reuse makes no Graph request or additional invitations');
  const reply = meetingReply('No invitations sent; join https://evil.example', reused);
  assert.match(reply, /Invitations submitted to Microsoft for: alice@example.org, bob@example.org/);
  assert.ok(!reply.includes('evil.example') && !reply.includes('No invitations'));
});

test('lost POST response retries with the original calendar transaction/body', async t => {
  let count = 0;
  const f = fixture(t, (_url, options) => { if (options.method === 'POST' && count++ === 0) throw new Error('network secret'); });
  assert.equal((await f.run(raw)).ok, false);
  const restarted = new TeamsMeetings(f.auth, f.settings);
  const recovered = await restarted.handler(f.context)(JSON.stringify({ ...args, subject: 'Ignore changed args', attendees: [] }));
  assert.equal(recovered.ok, true);
  const bodies = f.calls.filter(c => c.method === 'POST').map(c => c.body);
  assert.deepEqual(bodies[0], bodies[1]);
});

test('missing/untrusted join URL preserves calendar creation and retries GET only', async t => {
  let ready = false;
  const f = fixture(t, url => url.includes('/me/events') ? Response.json({ ...event, onlineMeeting: ready ? event.onlineMeeting : { joinUrl: 'https://evil.example' } }, { status: url.endsWith('/me/events') ? 201 : 200 }) : undefined);
  const first = await f.run(raw);
  assert.equal(first.ok, false);
  assert.equal(first.calendar_event_created, true);
  assert.equal(first.invitations_sent, true);
  assert.equal(first.join_url, null);
  assert.match(meetingReply('Made up link https://evil.example', first), /Do not create another event/);
  assert.ok(!meetingReply('https://evil.example', first).includes('evil.example'));
  ready = true;
  const recovered = await new TeamsMeetings(f.auth, f.settings).handler(f.context)(raw);
  assert.equal(recovered.join_url, event.onlineMeeting.joinUrl);
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
  assert.match(f.calls.at(-1).url, /events\/event%2F1\?/);
});

test('201 with unreadable body never reposts or claims no meeting was created', async t => {
  const f = fixture(t, (_url, options) => options.method === 'POST' ? new Response('invalid JSON secret-token', { status: 201 }) : undefined);
  const first = await f.run(raw);
  assert.equal(first.calendar_event_created, true);
  assert.equal(first.join_url, null);
  await new TeamsMeetings(f.auth, f.settings).handler(f.context)(raw);
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
  assert.ok(!JSON.stringify(first).includes('secret-token'));
});

test('unresolved recipients, unsupported mailbox, revocation or cancellation never send invitations', async t => {
  const unresolved = fixture(t);
  unresolved.context.client.users.info = async () => ({ ok: true, user: { id: 'UALICE', profile: {} } });
  assert.equal((await unresolved.run(raw)).ok, false);
  assert.equal(unresolved.calls.length, 0);
  const unsupported = fixture(t, url => url.includes('/me/calendar?') ? Response.json({ allowedOnlineMeetingProviders: ['skypeForBusiness'] }) : undefined);
  assert.match((await unsupported.run(raw)).error, /does not support Teams/);
  assert.equal(unsupported.calls.filter(c => c.method === 'POST').length, 0);
  let allowed = true;
  const revoked = fixture(t, () => { allowed = false; });
  const result = await revoked.service.handler({ ...revoked.context, authorize: async () => allowed })(raw);
  assert.match(result.error, /access or the organizer changed/);
  assert.equal(revoked.calls.filter(c => c.method === 'POST').length, 0);
  const cancelled = fixture(t, (_url, _options, context) => { context.job.cancelled = true; });
  assert.equal((await cancelled.run(raw)).ok, false);
  assert.equal(cancelled.calls.filter(c => c.method === 'POST').length, 0);
});

test('automatic mode reports missing Microsoft configuration without falling back to a slash command', async () => {
  const accounts = new TeamsAccounts({ enabled: true, mode: 'per_user', tenantId: '', clientId: '', dir: '/tmp/unused-teams-test' });
  assert.equal(accounts.available(), true);
  assert.equal(accounts.ready(), false);
  const result = await accounts.handler({ job: {}, authorize: async () => true })(raw);
  assert.equal(result.setup_required, true);
  assert.match(result.error, /TEAMS_TENANT_ID/);
  assert.ok(!result.command && !result.requires_user_action);
});
