import { createTeamsMeetingTool, validateMeeting } from './teams-meetings.js';

export const teamsCallsGuide = 'https://slack.com/help/articles/360046159513-Microsoft-Teams-Calls-for-Slack';
export const slackTeamsTool = {
  ...createTeamsMeetingTool,
  description: 'Prepare a handoff to the official Microsoft Teams Calls app already linked to Slack. This tool DOES NOT create or schedule a meeting and DOES NOT return a join URL. The requester must send the returned /teams-calls command themselves in the channel or DM composer, outside the thread. The official app handles Microsoft sign-in and posts the join prompt. Use when asked to start a Teams call. If a future date/time is requested, preserve it in starts_at but explain that this command starts a call when sent and cannot schedule it or set its duration. Never claim a meeting was created or invent a link. No tenant/client IDs or custom Microsoft login are needed. Return the next_step instructions to the requester.',
};

export function slackTeamsHandler({ job, authorize, scrub = text => text }) {
  return async (raw, { signal } = {}) => {
    let args;
    try { args = JSON.parse(scrub(raw)); validateMeeting(args); }
    catch (error) { return { ok: false, error: error instanceof SyntaxError ? 'Tool arguments must be valid JSON.' : error.message }; }
    signal?.throwIfAborted();
    if (job.cancelled || !(await authorize())) return { ok: false, error: 'Your current permissions do not allow preparing a Teams call.' };
    // Keep the copyable command on one line and prevent markup/command injection.
    const title = args.subject.replace(/[`\[\]<>]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!title) return { ok: false, error: 'Provide a plain-text meeting title.' };
    const command = `/teams-calls meeting [${title}]`;
    const nextStep = [
      'To start this call with Microsoft Teams Calls, send this command in the main channel or DM message box (outside this thread):',
      `\n\`\`\`\n${command}\n\`\`\``,
      '\nIf you haven’t connected Microsoft yet, open Slack → Apps → Microsoft Teams Calls → Home → Connect.',
      '\nThe Teams app will post its join prompt in that conversation. Copy the meeting link into this thread if you want it here.',
      args.starts_at !== null ? '\nThis command starts a call when you send it. It cannot schedule the requested date/time or set a duration; use Teams or Outlook to schedule that meeting.' : '\nThe call starts when you send the command; it does not set a duration or send calendar invitations.',
    ].join('\n');
    return { ok: true, created: false, scheduled: false, requires_user_action: true, command, join_url: null,
      calendar_event_created: false, invitations_sent: false, next_step: nextStep, help_url: teamsCallsGuide };
  };
}
