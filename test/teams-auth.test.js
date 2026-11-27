import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TeamsAuth, teamsConfig } from '../src/teams-auth.js';
import { fakeMsal, authResult, tenantId, clientId } from './helpers/msal.js';

function fixture(t, result = authResult) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'teams-auth-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = { enabled: true, tenantId, clientId, dir };
  const FakeClient = fakeMsal(result);
  const options = { createClient: args => new FakeClient(args) };
  return { auth: new TeamsAuth(config, options), config, options, dir };
}

test('shared organizer login persists encrypted private cache and refreshes after restart', async t => {
  const { auth, dir, config, options } = fixture(t);
  assert.equal(auth.ready(), false);
  let code;
  await auth.login(value => { code = value; });
  assert.equal(code.code, 'TESTCODE');
  assert.equal(auth.ready(), true);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  for (const name of ['cache.json', 'cache.key', 'organizer.json']) assert.equal(statSync(path.join(dir, name)).mode & 0o777, 0o600);
  const cache = readFileSync(path.join(dir, 'cache.json'), 'utf8');
  assert.ok(!cache.includes(authResult.accessToken));
  const restarted = new TeamsAuth(config, options);
  const token = await restarted.token();
  assert.equal(token.accessToken, authResult.accessToken);
  assert.equal(token.organizer.homeAccountId, authResult.account.homeAccountId);
  assert.notEqual(cache, readFileSync(path.join(dir, 'cache.json'), 'utf8'), 'refresh uses a fresh encryption nonce');
  restarted.logout();
  assert.equal(restarted.ready(), false);
  await assert.rejects(restarted.token(), /sign-in is unavailable/);
});

test('mismatched config or pinned account cannot silently select another organizer', async t => {
  const { auth, config, options, dir } = fixture(t);
  await auth.login(() => {});
  const changed = new TeamsAuth({ ...config, clientId: tenantId }, options);
  assert.equal(changed.ready(), false);
  await assert.rejects(changed.token(), /sign-in is unavailable/);
  const saved = JSON.parse(readFileSync(path.join(dir, 'organizer.json')));
  writeFileSync(path.join(dir, 'organizer.json'), JSON.stringify({ ...saved, homeAccountId: 'another-account' }));
  await assert.rejects(auth.token(), /sign-in is unavailable/);
});

test('invalid tenants, missing scope and personal/wrong tenant auth never enable Teams', async t => {
  const disabled = new TeamsAuth(teamsConfig({ TEAMS_TENANT_ID: 'common', TEAMS_CLIENT_ID: clientId }));
  assert.equal(disabled.ready(), false);
  await assert.rejects(disabled.login(() => {}), /Directory and Application UUIDs/);
  for (const result of [{ ...authResult, scopes: ['User.Read'] }, { ...authResult, tenantId: clientId }]) {
    const { auth } = fixture(t, result);
    await assert.rejects(auth.login(() => {}), /sign-in did not complete/);
    assert.equal(auth.ready(), false);
  }
});

test('tampered credentials fail closed without exposing cache contents', async t => {
  const { auth, dir } = fixture(t);
  await auth.login(() => {});
  const file = path.join(dir, 'cache.json');
  const saved = JSON.parse(readFileSync(file));
  saved.data = Buffer.from('secret private cache corrupted').toString('base64');
  writeFileSync(file, JSON.stringify(saved));
  await assert.rejects(auth.token(), error => /sign-in is unavailable/.test(error.message) && !/secret|corrupted/.test(error.message));
});
