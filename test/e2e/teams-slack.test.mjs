import { startBot, ok, J, finish } from './harness.mjs';

// This mode must never contact Microsoft Graph or start custom OAuth.
globalThis.fetch = async () => { throw new Error('Unexpected external request in Slack Calls mode'); };
globalThis.__msalDeviceLogin = async () => { throw new Error('Custom Microsoft login must not start'); };
const bot = await startBot({ TEAMS_ENABLED: 'true', TEAMS_ORGANIZER_MODE: 'slack_calls', TEAMS_TENANT_ID: '', TEAMS_CLIENT_ID: '' });
bot.setMode('teams');
await bot.mention('UMEM', 'create a Teams call for the design review');
const request = bot.gateway.requests[0];
ok(request.tools.some(tool => tool.name === 'create_teams_meeting' && tool.description.includes('DOES NOT create or schedule')), 'official-app handoff is declared without Microsoft IDs');
const result = JSON.parse(bot.gateway.requests[1].input.find(item => item.type === 'function_call_output').output);
ok(result.ok && result.requires_user_action && !result.created && !result.scheduled && result.join_url === null, 'function reports a handoff, not meeting creation');
const reply = bot.calls.filter(c => c.m === 'chat.update').at(-1).a;
ok(J(reply).includes('/teams-calls meeting [Design review]') && J(reply).includes('outside this thread'), 'reply contains the actual command and correct composer location');
ok(!J(reply).includes('The meeting is ready') && !J(reply).includes('teams.microsoft.com'), 'optimistic model text cannot invent a created meeting or join link');
ok(!bot.ephemerals().some(text => text.includes('TESTCODE')), 'Microsoft authentication is left to the official app');
ok(bot.calls.filter(c => c.m === 'chat.postMessage').every(c => c.a.thread_ts === bot.lastTs), 'Meow-AI only posts instructions in the original thread');
await bot.mention('UMEM', 'teams disconnect');
ok(bot.ephemerals().at(-1).includes('/teams-calls logout'), 'disconnect points to the official app’s supported command');
await bot.dm('UMEM', 'create a Teams call');
ok(J(bot.calls.filter(c => c.m === 'chat.update').at(-1)).includes('/teams-calls'), 'the same handoff is available in DMs');
bot.setMode('complete');
await bot.mention('UVIEW', 'create a Teams meeting');
ok(!bot.gateway.requests.at(-1).tools.some(t => t.name === 'create_teams_meeting'), 'existing role restrictions still apply');
finish();
