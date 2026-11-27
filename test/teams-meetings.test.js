import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TeamsMeetings, validateMeeting, meetingReply } from '../src/teams-meetings.js';

const now = Date.parse('2027-01-01T00:00:00Z');
const args = { subject: 'Design review', starts_at: null, duration_minutes: 30 };
const raw = JSON.stringify(args);
const graphResult = body => ({ id: 'meeting1', subject: body.subject, startDateTime: body.startDateTime, endDateTime: body.endDateTime,
  joinWebUrl: 'https://teams.microsoft.com/l/meetup-join/test-meeting' });
function fixture(t, fetchOverride) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'teams-meetings-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const organizer = { homeAccountId: 'organizer1', tenantId: 'tenant', clientId: 'client' };
  const auth = { config: { dir }, ready: () => true, organizer: () => organizer, token: async () => ({ accessToken: 'private-test-token', organizer }) };
  const calls = [];
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, options, body });
    return fetchOverride ? fetchOverride(body, options) : Response.json(graphResult(body), { status: 201 });
  };
  const settings = { fetchImpl, now: () => now };
  const service = new TeamsMeetings(auth, settings);
  const job = { channel: 'C123', user: 'U123', requestTs: '123.456', threadTs: '123.000' };
  return { auth, calls, service, job, settings, run: service.handler({ job, authorize: async () => true }), dir };
}

test('validates explicit timezone, calendar date, future time, duration and fields', () => {
  assert.deepEqual(validateMeeting({ ...args, starts_at: '2027-01-02T14:00:00+08:00' }, now), { subject: 'Design review', startDateTime: '2027-01-02T06:00:00.000Z', endDateTime: '2027-01-02T06:30:00.000Z' });
  for (const starts_at of [undefined, '', '2027-01-02T14:00:00', '2027-02-30T14:00:00Z', '2026-12-01T14:00:00Z', '2027-01-01T24:00:00Z']) assert.throws(() => validateMeeting({ ...args, starts_at }, now));
  for (const duration_minutes of [0, 1441, 2.2, '60']) assert.throws(() => validateMeeting({ ...args, duration_minutes }, now));
  assert.throws(() => validateMeeting({ ...args, organizer: 'attacker' }, now));
  assert.throws(() => validateMeeting({ ...args, subject: 'x\nfoo' }, now));
});

test('creates one meeting for concurrent subagents, repeated calls, and process restarts', async t => {
  const f = fixture(t);
  const results = await Promise.all([f.run(raw), f.run(raw), f.run(JSON.stringify({ ...args, subject: 'Changed title' }))]);
  assert.equal(f.calls.length, 1);
  assert.ok(results.every(result => result.ok && result.join_url === results[0].join_url));
  assert.equal(f.calls[0].url, 'https://graph.microsoft.com/v1.0/me/onlineMeetings/createOrGet');
  assert.equal(f.calls[0].options.redirect, 'error');
  assert.equal(f.calls[0].body.endDateTime, '2027-01-01T00:30:00.000Z');
  assert.equal(results[0].invitations_sent, false);
  assert.ok(!JSON.stringify(results).includes('private-test-token'));
  const restarted = new TeamsMeetings(f.auth, f.settings);
  assert.equal((await restarted.handler({ job: { ...f.job }, authorize: async () => true })(raw)).reused, true);
  assert.equal(f.calls.length, 1);
  await restarted.handler({ job: { ...f.job, requestTs: 'new-request' }, authorize: async () => true })(raw);
  assert.equal(f.calls.length, 2);
  assert.notEqual(f.calls[0].body.externalId, f.calls[1].body.externalId);
});

test('uncertain network result recovers using the saved externalId and original times', async t => {
  let attempt = 0;
  const f = fixture(t, body => { if (!attempt++) throw new Error('network failed with secret private-test-token'); return Response.json(graphResult(body)); });
  assert.equal((await f.run(raw)).ok, false);
  const restarted = new TeamsMeetings(f.auth, { ...f.settings, now: () => now + 50000 });
  const result = await restarted.handler({ job: f.job, authorize: async () => true })(JSON.stringify({ ...args, duration_minutes: 90 }));
  assert.equal(result.ok, true);
  assert.deepEqual(f.calls[0].body, f.calls[1].body);
  assert.equal(readdirSync(path.join(f.dir, 'meetings')).length, 1);
});

test('rechecks permissions and cancellation after token refresh before creating', async t => {
  const f = fixture(t);
  let allowed = true;
  f.auth.token = async () => { allowed = false; return { accessToken: 'token', organizer: f.auth.organizer() }; };
  const run = f.service.handler({ job: f.job, authorize: async () => allowed });
  assert.equal((await run(raw)).ok, false);
  assert.equal(f.calls.length, 0);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(run(raw, { signal: controller.signal }));
  f.auth.ready = () => false;
  assert.equal((await f.run(raw)).ok, false);
  assert.equal(f.calls.length, 0);
});

test('rejects untrusted join links and sanitizes upstream failures', async t => {
  for (const url of ['http://teams.microsoft.com/meeting', 'https://evil.example/meeting', 'https://teams.microsoft.com.evil.example/meeting', 'https://user:secret@teams.microsoft.com/meeting']) {
    const f = fixture(t, body => Response.json({ ...graphResult(body), joinWebUrl: url }));
    const result = await f.run(raw);
    assert.equal(result.ok, false);
    assert.equal(f.job.teamsMeeting, undefined);
    assert.ok(!result.error.includes(url));
  }
  for (const status of [401, 403, 429, 500]) {
    const f = fixture(t, () => Response.json({ error: { message: 'secret private-test-token' } }, { status }));
    const result = await f.run(raw);
    assert.equal(result.ok, false);
    assert.ok(!/secret|private-test-token/.test(result.error));
  }
});

test('preserves verified join link if model omits it and does not duplicate it', () => {
  const meeting = { ok: true, join_url: 'https://teams.microsoft.com/meeting' };
  const text = meetingReply('Ready.', meeting);
  assert.match(text, /https:\/\/teams.microsoft.com\/meeting/);
  assert.equal(meetingReply(text, meeting), text);
  assert.equal(meetingReply('Not created.', undefined), 'Not created.');
});
