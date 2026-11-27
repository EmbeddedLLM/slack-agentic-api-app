import path from 'node:path';
import { atomicJSON, readJSON, scopeKey } from './agentic-client.js';

export const createTeamsMeetingTool = {
  type: 'function', name: 'create_teams_meeting', strict: true,
  description: 'Create a real Microsoft Teams meeting join link using the configured shared work/school organizer. Use only when the requester asks to create a meeting or meeting link. Set starts_at=null for a meeting now, or an ISO 8601 date/time with explicit UTC offset (for example 2027-01-15T14:00:00+08:00). Use the requester’s current local time from the prompt; ask for clarification if the date/time/timezone is ambiguous. Use duration_minutes=60 unless another duration is requested. Creates a link only: no calendar event or email invitations. One meeting per Slack request; repeated calls return the same meeting and do not update it. Return the exact join_url only after ok=true. Never invent a link or claim invites were sent.',
  parameters: { type: 'object', additionalProperties: false, required: ['subject', 'starts_at', 'duration_minutes'], properties: {
    subject: { type: 'string', description: 'Short meeting title, 1–200 characters.' },
    starts_at: { type: ['string', 'null'], description: 'null for now, otherwise a future ISO 8601 time with explicit offset or Z.' },
    duration_minutes: { type: 'integer', minimum: 1, maximum: 1440, description: 'Meeting duration in minutes. Default to 60 if unspecified.' },
  } },
};

export function validateMeeting(args, now = Date.now()) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !['subject', 'starts_at', 'duration_minutes'].includes(key))) throw new Error('Use only the fields in the meeting tool schema.');
  if (typeof args.subject !== 'string' || !args.subject.trim() || args.subject.length > 200 || /[\x00-\x1f\x7f]/.test(args.subject)) throw new Error('Provide a meeting subject of 1–200 characters without control characters.');
  if (!Number.isInteger(args.duration_minutes) || args.duration_minutes < 1 || args.duration_minutes > 1440) throw new Error('Duration must be 1–1440 whole minutes.');
  let start = now;
  if (args.starts_at !== null) {
    const match = typeof args.starts_at === 'string' && /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d{1,3})?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(args.starts_at);
    if (!match) throw new Error('Specify starts_at=null for now, or a date/time including seconds and an explicit UTC offset or Z. Clarify ambiguous schedules with the requester.');
    const [year, month, day] = match.slice(1, 4).map(Number);
    const calendar = new Date(Date.UTC(year, month - 1, day));
    start = Date.parse(args.starts_at);
    if (!Number.isFinite(start) || calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) throw new Error('The meeting date is invalid.');
    if (start < now - 60000) throw new Error('The requested meeting time is in the past. Ask for a future time or use null for now.');
  }
  return { subject: args.subject.trim(), startDateTime: new Date(start).toISOString(), endDateTime: new Date(start + args.duration_minutes * 60000).toISOString() };
}

function confirmedMeeting(data) {
  const url = new URL(data.joinWebUrl);
  if (url.protocol !== 'https:' || !['teams.microsoft.com', 'teams.cloud.microsoft'].includes(url.hostname) || url.username || url.password || url.port || /[<>\s]/.test(data.joinWebUrl)) throw new Error('Invalid meeting link.');
  if (typeof data.id !== 'string' || !data.id || typeof data.subject !== 'string' || !Number.isFinite(Date.parse(data.startDateTime)) || !Number.isFinite(Date.parse(data.endDateTime))) throw new Error('Incomplete meeting result.');
  return { ok: true, meeting_id: data.id, subject: data.subject, join_url: url.href, starts_at: data.startDateTime, ends_at: data.endDateTime,
    calendar_event_created: false, invitations_sent: false, delivery: 'Include this exact join URL in the Slack thread. This is a link-only meeting under the shared organizer.' };
}

async function responseJSON(response) {
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 1000000) throw new Error('Oversized response.');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); }
}

function graphError(status) {
  if (status === 401) return 'Microsoft rejected the organizer sign-in. An admin must run npm run teams:login again.';
  if (status === 403) return 'Microsoft denied meeting creation. Check delegated OnlineMeetings.ReadWrite consent, the organizer’s Teams license, and organization policies.';
  if (status === 429) return 'Microsoft is rate limiting meetings. Wait before trying again; a retry within this request reuses the same meeting.';
  return 'Microsoft did not confirm the meeting. A retry within this Slack request uses the same meeting ID; starting a new Slack request may create another meeting.';
}

export class TeamsMeetings {
  constructor(auth, { fetchImpl = fetch, now = () => Date.now(), timeoutMs = 30000 } = {}) {
    this.auth = auth;
    this.fetch = fetchImpl;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.locks = new Map();
  }
  ready() { return this.auth.ready(); }
  handler({ job, authorize, scrub = text => text }) {
    return async (raw, { signal } = {}) => {
      let args;
      try { args = JSON.parse(scrub(raw)); validateMeeting(args, this.now()); }
      catch (error) { return { ok: false, error: error instanceof SyntaxError ? 'Tool arguments must be valid JSON.' : error.message }; }
      let organizer;
      try { organizer = this.auth.organizer(); }
      catch { return { ok: false, error: 'Teams is not configured. Ask an admin to complete the organizer sign-in.' }; }
      const id = scopeKey(['teams', organizer.tenantId, organizer.clientId, organizer.homeAccountId, job.channel, job.user, job.requestTs]);
      const previous = this.locks.get(id) || Promise.resolve();
      const pending = previous.catch(() => {}).then(async () => {
        signal?.throwIfAborted();
        if (!this.ready() || job.cancelled || !job.requestTs || !/^[CDG][A-Z0-9]+$/.test(job.channel) || !(await authorize())) return { ok: false, error: 'Your current permissions do not allow creating a Teams meeting here.' };
        const file = path.join(this.auth.config.dir, 'meetings', `${id}.json`);
        let saved = readJSON(file);
        if (saved?.result) {
          job.teamsActionsAttempted = true;
          job.teamsMeeting = saved.result;
          return { ...saved.result, reused: true };
        }
        let token;
        try { token = await this.auth.token(); }
        catch { return { ok: false, error: 'Teams organizer sign-in is unavailable or expired. An admin must run npm run teams:login.' }; }
        signal?.throwIfAborted();
        if (job.cancelled || !(await authorize()) || token.organizer.homeAccountId !== organizer.homeAccountId) return { ok: false, error: 'Meeting creation stopped because access or the organizer changed.' };
        if (!saved) {
          saved = { body: { ...validateMeeting(args, this.now()), externalId: `slack-agentic-${id}` }, status: 'pending' };
          atomicJSON(file, saved);
        }
        job.teamsActionsAttempted = true;
        job.phase = 'Creating the Teams meeting';
        try {
          const response = await this.fetch('https://graph.microsoft.com/v1.0/me/onlineMeetings/createOrGet', {
            method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${token.accessToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(saved.body), signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(this.timeoutMs)]),
          });
          if (![200, 201].includes(response.status)) {
            await response.body?.cancel();
            return { ok: false, error: graphError(response.status) };
          }
          const result = confirmedMeeting(await responseJSON(response));
          job.teamsMeeting = result;
          atomicJSON(file, { ...saved, status: 'ready', result });
          return result;
        } catch {
          // Keep the pending request: Graph createOrGet can recover an uncertain
          // write using the same externalId, even after a process restart.
          return { ok: false, error: graphError() };
        }
      });
      this.locks.set(id, pending);
      try { return await pending; } finally { if (this.locks.get(id) === pending) this.locks.delete(id); }
    };
  }
}

export function meetingReply(answer, meeting) {
  if (!meeting?.ok || answer.includes(meeting.join_url)) return answer;
  return `${answer}\n\n[Join the Teams meeting](${meeting.join_url})\nNo calendar invitation was sent.`.trim();
}
