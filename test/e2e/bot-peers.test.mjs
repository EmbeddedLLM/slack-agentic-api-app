import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { finish, ok, startBot } from './harness.mjs';

const bot = await startBot({ THREAD_FOLLOW: 'true' });
const file = path.join(bot.dir, 'access.json');
const policy = JSON.parse(readFileSync(file));
policy.defaultRole = 'member';
policy.botPeers = { UPEER: { botId: 'BPEER', role: 'member', maxRepliesPerThread: 3 } };
writeFileSync(file, JSON.stringify(policy));
bot.users.UPEER = { is_bot: true, profile: { bot_id: 'BPEER' }, real_name: 'Latte test' };
bot.users.UOTHER = { is_bot: true, profile: { bot_id: 'BOTHER' } };
bot.users.UBOT = { is_bot: true, profile: { bot_id: 'B1' } };
bot.members.push('UPEER');
let seq = 5000;
const event = (overrides = {}) => ({ type: 'message', subtype: 'bot_message', bot_id: 'BPEER', user: 'UPEER',
  channel: 'C0TEST', channel_type: 'channel', thread_ts: '123.000001', ts: `${++seq}.000001`, text: '<@UBOT> Review this idea', ...overrides });
const deliver = e => bot.app.h.event[e.type]({ event: e, client: bot.client });
const addressed = () => bot.calls.filter(c => c.m === 'chat.postMessage' && c.a.text.startsWith('<@UPEER>'));

await bot.mention('UMEM', 'ask <@UPEER> What is your view?', '123.000001');
ok(addressed().at(-1)?.a.text.includes('What is your view?') && addressed().at(-1)?.a.text.includes('<@UBOT>'), 'human ask sends a real peer mention and requests a tagged reply');
ok(bot.agentCalls().length === 0, 'ask relays the human question without an extra model call');
const first = event();
await deliver(first);
ok(bot.agentCalls().length === 1, 'trusted peer bot_message reaches the WebSocket gateway');
ok(addressed().length === 2 && addressed().at(-1).a.text.includes('normal answer'), 'completed answer is a fresh, addressed post rather than only a placeholder update');
ok(bot.agentCalls()[0].tools.some(t => t.type === 'web_search'), 'peer gets its explicitly configured role tools');
ok(bot.agentCalls()[0].prompt.includes('another team assistant'), 'model knows it is answering a peer');
await deliver({ ...first, type: 'app_mention', subtype: undefined });
ok(bot.agentCalls().length === 1, 'overlapping message and app_mention events are deduplicated');
for (const e of [event({ user: 'UOTHER', bot_id: 'BOTHER' }), event({ user: 'UBOT', bot_id: 'B1' }),
  event({ bot_id: 'BOTHER' }), event({ user: 'UMEM' }), event({ text: 'ambient message' }),
  event({ subtype: 'message_changed' }), event({ hidden: true }), event({ channel: 'D0DM', channel_type: 'im' })]) await deliver(e);
ok(bot.agentCalls().length === 1, 'unknown/self/mismatched bots, untagged text, edits, hidden messages and DMs are ignored');
await deliver(event({ user: undefined }));
ok(bot.agentCalls().length === 2, 'classic bot event without user resolves through pinned botId');
await deliver(event({ type: 'app_mention', subtype: undefined, bot_id: undefined }));
ok(bot.agentCalls().length === 3 && addressed().at(-1).a.text.includes('Exchange limit reached'), 'verified peer mention without bot_id works and announces the last turn');
await deliver(event());
ok(bot.agentCalls().length === 3 && addressed().length === 4, 'fourth peer message causes neither inference nor another reply');
await bot.mention('UVIEW', 'ask <@UPEER> reset please', '123.000001');
await deliver(event());
ok(bot.agentCalls().length === 3 && addressed().length === 4, 'viewer cannot reset or start exchanges');
await bot.mention('UMEM', 'ask <@UPEER> Continue with a conclusion', '123.000001');
await deliver(event({ text: '<@UBOT> ask <@UPEER> recursive exchange' }));
ok(bot.agentCalls().length === 4 && addressed().length === 6, 'human can restart; peer ask text is a normal question and cannot relay or reset');
ok(!bot.agentCalls().at(-1).multi_agent.enabled, 'peer does not launch a nested multi-agent run');
policy.botPeers.UPEER.channels = ['COTHER'];
writeFileSync(file, JSON.stringify(policy));
await deliver(event({ thread_ts: '999.000001' }));
ok(bot.agentCalls().length === 4, 'channel allowlist applies immediately');
delete policy.botPeers;
writeFileSync(file, JSON.stringify(policy));
await deliver(event({ thread_ts: '999.000001' }));
await bot.mention('UOTHER', 'hello');
ok(bot.agentCalls().length === 4, 'removing a peer denies it even with defaultRole member');
ok(bot.calls.filter(c => ['chat.postMessage', 'chat.postEphemeral'].includes(c.m)).every(c => c.a.thread_ts && !c.a.reply_broadcast), 'all messages stay in the originating thread');
finish();
