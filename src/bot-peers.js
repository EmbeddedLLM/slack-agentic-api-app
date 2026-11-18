import path from 'node:path';
import { atomicJSON, readJSON, scopeKey } from './agentic-client.js';

// Peer identities are pinned to both Slack IDs, never display names. Peers do
// not inherit defaultRole or a human's users entry.
export function normalizeBotPeers(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('botPeers must be an object');
  const peers = {};
  const botIds = new Set();
  for (const [userId, value] of Object.entries(raw)) {
    if (userId.startsWith('_')) continue;
    if (!/^[UW][A-Z0-9]+$/.test(userId) || !value || !/^B[A-Z0-9]+$/.test(value.botId || '')) {
      throw new Error('Each botPeers entry needs a Slack user ID and botId');
    }
    if (botIds.has(value.botId)) throw new Error('Duplicate botPeers botId');
    botIds.add(value.botId);
    const role = value.role ?? 'viewer';
    if (!['none', 'viewer', 'member'].includes(role)) throw new Error('Bot peer roles must be none, viewer, or member');
    const maxRepliesPerThread = value.maxRepliesPerThread ?? 3;
    if (!Number.isInteger(maxRepliesPerThread) || maxRepliesPerThread < 1 || maxRepliesPerThread > 10) {
      throw new Error('Bot peer maxRepliesPerThread must be between 1 and 10');
    }
    if (value.channels !== undefined && (!Array.isArray(value.channels) || value.channels.some(id => !/^[CG][A-Z0-9]+$/.test(id)))) {
      throw new Error('Bot peer channels must be an array of Slack channel IDs');
    }
    peers[userId] = { userId, botId: value.botId, role, maxRepliesPerThread,
      ...(value.channels !== undefined ? { channels: [...new Set(value.channels)] } : {}) };
  }
  return peers;
}

export const peerInChannel = (peer, channel) => Boolean(peer && /^[CG]/.test(channel) && (!peer.channels || peer.channels.includes(channel)));

// Reserve before awaiting anything or calling the gateway. The counter and
// event IDs survive restarts. Only an authorized human's ask command resets it.
export class PeerReplyBudget {
  constructor(dir) { this.dir = dir; }

  load(peer, channel, threadTs) {
    const file = path.join(this.dir, `${scopeKey({ peer: peer.userId, channel, threadTs })}.json`);
    const state = readJSON(file) ?? { replies: 0, seen: [] };
    if (!Number.isInteger(state.replies) || state.replies < 0 || !Array.isArray(state.seen) || state.seen.some(id => typeof id !== 'string')) {
      throw new Error('Invalid saved bot peer budget');
    }
    return { file, state };
  }

  reset(peer, channel, threadTs, eventTs) {
    const { file, state } = this.load(peer, channel, threadTs);
    const id = `ask:${eventTs}`;
    if (state.seen.includes(id)) return false;
    atomicJSON(file, { replies: 0, seen: [...state.seen, id].slice(-100) });
    return true;
  }

  take(peer, channel, threadTs, eventTs) {
    const { file, state } = this.load(peer, channel, threadTs);
    if (state.seen.includes(eventTs) || state.replies >= peer.maxRepliesPerThread) return null;
    state.replies++;
    state.seen = [...state.seen, eventTs].slice(-100);
    atomicJSON(file, state);
    return { remaining: peer.maxRepliesPerThread - state.replies };
  }
}
