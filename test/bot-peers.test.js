import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeBotPeers, peerInChannel, PeerReplyBudget } from '../src/bot-peers.js';

const peer = normalizeBotPeers({ UPEER: { botId: 'BPEER' } }).UPEER;

test('peer policy pins identities and rejects administrative or unbounded access', () => {
  assert.equal(peer.role, 'viewer');
  assert.equal(peer.maxRepliesPerThread, 3);
  for (const invalid of [{ botId: 'not-a-bot' }, { botId: 'BPEER', role: 'admin' },
    { botId: 'BPEER', maxRepliesPerThread: 0 }, { botId: 'BPEER', maxRepliesPerThread: 11 },
    { botId: 'BPEER', channels: 'C1' }]) {
    assert.throws(() => normalizeBotPeers({ UPEER: invalid }));
  }
  assert.throws(() => normalizeBotPeers({ UPEER: { botId: 'BPEER' }, UOTHER: { botId: 'BPEER' } }));
  assert.equal(peerInChannel(peer, 'DPRIVATE'), false);
  assert.equal(peerInChannel({ ...peer, channels: ['C1'] }, 'C2'), false);
  assert.equal(peerInChannel({ ...peer, channels: [] }, 'C1'), false);
  assert.equal(peerInChannel(peer, 'GPRIVATE'), true);
});

test('reply budget and duplicate suppression survive restarts; only a new human ask resets it', t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bot-peer-budget-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let budget = new PeerReplyBudget(dir);
  assert.deepEqual(budget.take(peer, 'C1', '1.1', '2.1'), { remaining: 2 });
  budget = new PeerReplyBudget(dir);
  assert.equal(budget.take(peer, 'C1', '1.1', '2.1'), null);
  assert.deepEqual(budget.take(peer, 'C1', '1.1', '2.2'), { remaining: 1 });
  assert.deepEqual(budget.take(peer, 'C1', '1.1', '2.3'), { remaining: 0 });
  assert.equal(new PeerReplyBudget(dir).take(peer, 'C1', '1.1', '2.4'), null);
  assert.equal(budget.reset(peer, 'C1', '1.1', '3.1'), true);
  assert.equal(budget.take(peer, 'C1', '1.1', '2.1'), null);
  assert.deepEqual(budget.take(peer, 'C1', '1.1', '3.2'), { remaining: 2 });
  assert.equal(budget.reset(peer, 'C1', '1.1', '3.1'), false);
  assert.deepEqual(budget.take(peer, 'C1', '1.1', '3.3'), { remaining: 1 });
  assert.deepEqual(budget.take(peer, 'C2', '1.1', '2.1'), { remaining: 2 });
  assert.deepEqual(budget.take(peer, 'C1', '9.1', '2.1'), { remaining: 2 });
});

test('corrupt persisted budget fails closed', t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bot-peer-budget-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const budget = new PeerReplyBudget(dir);
  budget.take(peer, 'C1', '1.1', '2.1');
  writeFileSync(path.join(dir, readdirSync(dir)[0]), '{broken');
  assert.throws(() => budget.take(peer, 'C1', '1.1', '2.2'));
  assert.throws(() => budget.reset(peer, 'C1', '1.1', '2.3'));
});
