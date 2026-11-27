import test from 'node:test';
import assert from 'node:assert/strict';
import { slackTeamsHandler } from '../src/teams-slack.js';
import { TeamsAccounts } from '../src/teams-accounts.js';

test('scheduled requests return an explicit limitation and never schedule or claim a link', async () => {
  const run = slackTeamsHandler({ job: {}, authorize: async () => true });
  const result = await run(JSON.stringify({ subject: 'Design review', starts_at: new Date(Date.now() + 86400000).toISOString(), duration_minutes: 30 }));
  assert.equal(result.created, false);
  assert.equal(result.scheduled, false);
  assert.equal(result.join_url, null);
  assert.match(result.next_step, /cannot schedule the requested date\/time/);
  assert.match(result.next_step, /Copy the meeting link into this thread/);
});

test('handoff honors revocation/cancellation and prevents command markup injection', async () => {
  const args = JSON.stringify({ subject: 'Review ``` <@USER> [now]', starts_at: null, duration_minutes: 60 });
  const run = slackTeamsHandler({ job: {}, authorize: async () => true });
  const result = await run(args);
  assert.equal(result.command, '/teams-calls meeting [Review @USER now]');
  assert.equal((await slackTeamsHandler({ job: {}, authorize: async () => false })(args)).ok, false);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(run(args, { signal: controller.signal }));
});

test('official-app mode needs no Graph auth objects, account files or tenant/client IDs', async () => {
  const config = { mode: 'slack_calls', enabled: true };
  const service = new TeamsAccounts(config, { makeAuth: () => { throw new Error('Must not construct Graph auth'); } });
  assert.equal(service.ready(), true);
  assert.match(service.tool().description, /official Microsoft Teams Calls/);
  const raw = JSON.stringify({ subject: 'Review', starts_at: null, duration_minutes: 60 });
  const handler = service.handler({ job: {}, authorize: async () => true });
  assert.equal((await handler(raw)).requires_user_action, true);
  config.enabled = false;
  assert.equal((await handler(raw)).ok, false);
});
