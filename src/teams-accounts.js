import path from 'node:path';
import { TeamsAuth, teamsConfig } from './teams-auth.js';
import { TeamsMeetings, createTeamsMeetingTool, validateMeeting } from './teams-meetings.js';
import { scopeKey } from './agentic-client.js';
import { slackTeamsTool, slackTeamsHandler } from './teams-slack.js';

// OAuth belongs to the Slack requester, never to a model-supplied user/organizer.
export class TeamsAccounts {
  constructor(config = teamsConfig(), { makeAuth = settings => new TeamsAuth(settings), makeMeetings = auth => new TeamsMeetings(auth) } = {}) {
    if (!['slack_calls', 'shared', 'per_user'].includes(config.mode)) throw new Error('TEAMS_ORGANIZER_MODE must be slack_calls, shared or per_user.');
    this.config = config;
    this.makeAuth = makeAuth;
    this.makeMeetings = makeMeetings;
    this.shared = config.mode === 'slack_calls' ? null : makeMeetings(makeAuth(config));
    this.accounts = new Map();
    this.signIns = new Map();
  }
  ready() {
    if (this.config.mode === 'slack_calls') return this.config.enabled;
    if (this.config.mode === 'shared') return this.shared.ready();
    try { this.shared.auth.validate(); return this.config.enabled; } catch { return false; }
  }
  tool() {
    if (this.config.mode === 'slack_calls') return slackTeamsTool;
    if (this.config.mode === 'shared') return createTeamsMeetingTool;
    return { ...createTeamsMeetingTool, description: createTeamsMeetingTool.description
      .replace('configured shared work/school organizer', 'requester’s own work/school Microsoft account') +
      ' If Microsoft sign-in is needed, the app sends private instructions to the requester, waits up to five minutes, then creates the meeting automatically. Do not ask for passwords, app IDs, tokens or login codes in conversation.' };
  }
  account(job) {
    if (!/^[A-Z0-9]+$/.test(job.teamId || '') || !/^[UW][A-Z0-9]+$/.test(job.user || '')) throw new Error('Cannot identify the Slack requester for Microsoft sign-in.');
    const key = scopeKey([job.teamId, job.user]);
    if (!this.accounts.has(key)) {
      const auth = this.makeAuth({ ...this.config, dir: path.join(this.config.dir, 'users', key) });
      this.accounts.set(key, this.makeMeetings(auth));
    }
    return { key, service: this.accounts.get(key) };
  }
  async disconnect(job) {
    if (this.config.mode === 'slack_calls') return 'To disconnect the official Teams Calls app, send `/teams-calls logout` in the main channel or DM message box and confirm there. Meow-AI does not hold that Microsoft sign-in.';
    if (this.config.mode !== 'per_user') return 'This installation uses a shared organizer. Ask an admin to manage its sign-in.';
    const { key, service } = this.account(job);
    const pending = this.signIns.get(key);
    if (pending) { pending.controller.abort(new Error('Microsoft sign-in disconnected.')); await pending.done; }
    await service.auth.locked(() => service.auth.logout());
    return 'Your saved Microsoft sign-in was removed. Existing meetings are unchanged. Your next meeting request will ask you to sign in again.';
  }
  handler(context) {
    if (this.config.mode === 'slack_calls') return slackTeamsHandler({ ...context, authorize: async () => this.ready() && await context.authorize() });
    if (this.config.mode === 'shared') return this.shared.handler(context);
    const { job, authorize, client, scrub = text => text } = context;
    return async (raw, { signal } = {}) => {
      try { validateMeeting(JSON.parse(scrub(raw))); }
      catch (error) { return { ok: false, error: error instanceof SyntaxError ? 'Tool arguments must be valid JSON.' : error.message }; }
      signal?.throwIfAborted();
      if (!this.ready() || job.cancelled || !(await authorize())) return { ok: false, error: 'Your current permissions do not allow creating a Teams meeting.' };
      const { key, service } = this.account(job);
      if (this.signIns.has(key)) return { ok: false, error: 'You already have a Microsoft sign-in pending for another meeting request. Complete or cancel that request first.' };
      try { await service.auth.token(); }
      catch {
        // Recheck after the async silent refresh: two requests must not both
        // prompt the same Slack member to connect different Microsoft accounts.
        if (this.signIns.has(key)) return { ok: false, error: 'Complete your pending Microsoft sign-in first.' };
        if (job.teamsSignInAttempted || job.teamsActionsAttempted) return { ok: false, error: 'This request already attempted Microsoft sign-in or meeting creation. Check any confirmed meeting link, then send a new request when ready.' };
        job.teamsSignInAttempted = true;
        job.teamsActionsAttempted = true;
        const controller = new AbortController();
        let finish;
        const done = new Promise(resolve => { finish = resolve; });
        this.signIns.set(key, { controller, done });
        const combined = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
        job.phase = 'Waiting for your private Microsoft sign-in';
        try {
          await service.auth.login(async ({ uri, code }) => {
            combined.throwIfAborted();
            if (job.cancelled || !(await authorize())) throw new Error('Access changed.');
            // Ephemeral delivery works in channels, group DMs and 1:1 DMs and
            // is excluded from history. Never expose login codes to the model.
            const result = await client.chat.postEphemeral({ channel: job.channel, user: job.user, thread_ts: job.threadTs,
              text: `To create your Teams meeting, open <${uri}|Microsoft sign-in> and enter code \`${code}\`. Sign in with your own work/school account within five minutes. I’ll then create the meeting and post its link in this thread. Only you can see this message. Don’t share the code.`, parse: 'none' });
            if (result?.ok !== true) throw new Error('Private sign-in message failed.');
          }, { signal: combined });
        } catch {
          if (signal?.aborted) throw signal.reason;
          return { ok: false, error: 'Microsoft sign-in was not completed; no meeting was created. Ask again when ready, complete the private sign-in within five minutes, and use your organization’s Teams-enabled account.' };
        } finally { this.signIns.delete(key); finish(); }
      }
      signal?.throwIfAborted();
      const result = await service.handler(context)(raw, { signal });
      if (result.ok) result.delivery = 'Include this exact join URL in the Slack thread. The meeting is organized by the requester’s connected Microsoft account. No calendar invitations were sent.';
      return result;
    };
  }
}
