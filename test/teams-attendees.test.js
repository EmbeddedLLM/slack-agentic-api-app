import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveMeetingAttendees, validateAttendees } from '../src/teams-attendees.js';

test('resolves only explicit request recipients and deduplicates verified Slack emails', async () => {
  const calls = [];
  const context = { requestText: 'Invite <@UALICE> and <mailto:alice@example.com|alice@example.com> plus bob@example.org',
    client: { users: { info: async ({ user }) => { calls.push(user); return { ok: true, user: { id: user, profile: { email: 'Alice@example.com' } } }; } } } };
  const attendees = await resolveMeetingAttendees(['UALICE', 'alice@example.com', 'bob@example.org', 'UALICE'], context);
  assert.deepEqual(attendees.map(a => a.emailAddress.address), ['alice@example.com', 'bob@example.org']);
  assert.deepEqual(calls, ['UALICE']);
  await assert.rejects(resolveMeetingAttendees(['UMALLORY'], context), /@mention every invitee/);
  await assert.rejects(resolveMeetingAttendees(['guessed@example.org'], context), /Never infer email/);
  assert.deepEqual(calls, ['UALICE'], 'unrequested IDs never trigger a lookup');
});

test('missing email/scope, failed lookup, wrong identity, bots and deleted users fail the whole list', async () => {
  for (const response of [{ ok: false }, { ok: true, user: { id: 'UALICE', profile: {} } },
    { ok: true, user: { id: 'UOTHER', profile: { email: 'other@example.org' } } },
    ...['is_bot', 'is_app_user', 'deleted'].map(flag => ({ ok: true, user: { id: 'UALICE', [flag]: true, profile: { email: 'alice@example.org' } } }))]) {
    await assert.rejects(resolveMeetingAttendees(['bob@example.org', 'UALICE'], { requestText: 'Invite bob@example.org and <@UALICE>',
      client: { users: { info: async () => response } } }), /No meeting or invitations were created/);
  }
  await assert.rejects(resolveMeetingAttendees(['UALICE'], { requestText: '<@UALICE>', client: { users: { info: async () => { throw new Error('secret token'); } } } }), error => !error.message.includes('secret') && /email address/.test(error.message));
  for (const args of [['Alice'], ['x@example.org\n'], ['https://example.org'], [null], 'alice@example.com', Array(21).fill('alice@example.com')]) assert.throws(() => validateAttendees(args));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(resolveMeetingAttendees(['alice@example.org'], { requestText: 'alice@example.org', signal: controller.signal }));
});
