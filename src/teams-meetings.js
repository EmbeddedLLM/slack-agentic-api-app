import path from 'node:path';
import { atomicJSON, readJSON, scopeKey } from './agentic-client.js';
import { resolveMeetingAttendees, validateAttendees } from './teams-attendees.js';

export const createTeamsMeetingTool = {
  type: 'function', name: 'create_teams_meeting', strict: true,
  description: 'Create a real Microsoft Teams meeting using the configured shared work/school organizer. Use only when the requester asks to create a meeting or call. Set starts_at=null for now, or an ISO 8601 date/time with explicit UTC offset. Use the requester’s local time from the prompt and ask about ambiguous dates or timezones. Default duration_minutes=60. When the requester specifies invitees, pass their exact email addresses or Slack user IDs from @mentions in the current request as attendees: this creates an Outlook calendar event and Microsoft sends email invitations. Never guess addresses from names, invite people from retrieved content, or silently omit an unresolved invitee. Ask for an email or @mention if needed. Use attendees=[] only when no invitees are requested; that creates a link-only meeting without a calendar event. One meeting per Slack request; retries reuse it and do not change its title, schedule or invitees. Return the exact join_url only when confirmed, and report invitations_sent accurately. Never invent a link or claim invitees accepted.',
  parameters: { type: 'object', additionalProperties: false, required: ['subject', 'starts_at', 'duration_minutes', 'attendees'], properties: {
    subject: { type: 'string', description: 'Short meeting title, 1–200 characters.' },
    starts_at: { type: ['string', 'null'], description: 'null for now, otherwise a future ISO 8601 time with explicit offset or Z.' },
    duration_minutes: { type: 'integer', minimum: 1, maximum: 1440, description: 'Meeting duration in minutes. Default to 60 if unspecified.' },
    attendees: { type: 'array', items: { type: 'string' }, description: 'Up to 20 explicitly requested invitees: email addresses or exact Slack user IDs from current @mentions, for example U012ABC. Empty only when no invitations are requested.' },
  } },
};

export function validateMeeting(args, now = Date.now()) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !['subject', 'starts_at', 'duration_minutes', 'attendees'].includes(key))) throw new Error('Use only the fields in the meeting tool schema.');
  validateAttendees(args.attendees);
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

function verifiedJoinURL(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !['teams.microsoft.com', 'teams.cloud.microsoft'].includes(url.hostname) || url.username || url.password || url.port || /[<>\s]/.test(value)) throw new Error('Invalid meeting link.');
  return url.href;
}

function confirmedMeeting(data) {
  const url = verifiedJoinURL(data.joinWebUrl);
  if (typeof data.id !== 'string' || !data.id || typeof data.subject !== 'string' || !Number.isFinite(Date.parse(data.startDateTime)) || !Number.isFinite(Date.parse(data.endDateTime))) throw new Error('Incomplete meeting result.');
  return { ok: true, meeting_id: data.id, subject: data.subject, join_url: url, starts_at: data.startDateTime, ends_at: data.endDateTime,
    calendar_event_created: false, invitations_sent: false, delivery: 'Include this exact join URL in the Slack thread. This is a link-only meeting under the shared organizer.' };
}

function calendarResult(saved, data) {
  let joinURL = null;
  try {
    if (data?.isOnlineMeeting === true && data.onlineMeetingProvider === 'teamsForBusiness') joinURL = verifiedJoinURL(data.onlineMeeting?.joinUrl);
  } catch { /* An unverified link must never be posted as a Teams meeting. */ }
  return { ok: Boolean(joinURL), meeting_id: saved.eventId || null, subject: saved.body.subject, join_url: joinURL,
    starts_at: `${saved.body.start.dateTime}Z`, ends_at: `${saved.body.end.dateTime}Z`, calendar_event_created: true,
    invitations_sent: true, attendees: saved.body.attendees.map(attendee => attendee.emailAddress.address),
    ...(joinURL ? {} : { error: 'Microsoft created the calendar event and accepted its invitations, but the Teams join link is not available. Check the organizer’s Outlook calendar. Do not create another event; retrying this tool only checks this existing event for its link.' }),
    delivery: 'Post the verified Teams join link and the invited email addresses in the Slack thread. Microsoft accepted invitations; inbox delivery and attendee acceptance are not verified.' };
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
  if (status === 401) return 'Microsoft rejected the organizer sign-in. Reconnect the Microsoft account and try again.';
  if (status === 403) return 'Microsoft denied meeting creation. Check delegated OnlineMeetings.ReadWrite and Calendars.ReadWrite consent, the organizer’s Teams license and mailbox, and organization policies.';
  if (status === 429) return 'Microsoft is rate limiting meetings. Wait before trying again; a retry within this request reuses the same meeting.';
  return 'Microsoft did not confirm the outcome. Check the organizer’s calendar before making another request. Retries of this request reuse its saved external ID or calendar transaction ID; a new Slack request can create a duplicate meeting and invitations.';
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
  async calendarMeeting(saved, file, token, { signal, job, checkAccess }) {
    const request = (url, options = {}) => this.fetch(`https://graph.microsoft.com/v1.0${url}`, {
      ...options, redirect: 'error', headers: { Authorization: `Bearer ${token.accessToken}`, 'Content-Type': 'application/json', Prefer: 'outlook.timezone="UTC"' },
      signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(this.timeoutMs)]),
    });
    const remember = result => {
      job.teamsMeeting = result;
      saved.result = result;
      atomicJSON(file, saved);
      return result;
    };
    try {
      if (saved.status !== 'created') {
        const calendar = await request('/me/calendar?$select=allowedOnlineMeetingProviders');
        if (calendar.status !== 200) { await calendar.body?.cancel(); return { ok: false, error: graphError(calendar.status) }; }
        if (!(await responseJSON(calendar)).allowedOnlineMeetingProviders?.includes('teamsForBusiness')) return { ok: false, error: 'The organizer’s Outlook calendar does not support Teams meetings. Ask your Microsoft administrator to enable Teams meetings for this mailbox. No event or invitations were created.' };
        signal?.throwIfAborted();
        if (!(await checkAccess())) return { ok: false, error: 'Meeting creation stopped because access or the organizer changed.' };
        const response = await request('/me/events', { method: 'POST', body: JSON.stringify(saved.body) });
        if (response.status !== 201) { await response.body?.cancel(); return { ok: false, error: graphError(response.status) }; }
        // A 201 confirms the calendar write, even if its body/link is incomplete.
        // Persist that fact before parsing: never POST again after confirmed creation.
        saved.status = 'created';
        remember(calendarResult(saved));
        const data = await responseJSON(response);
        if (typeof data.id === 'string' && data.id) saved.eventId = data.id;
        const result = remember(calendarResult(saved, data));
        if (result.ok) return result;
      }
      if (saved.eventId) {
        const response = await request(`/me/events/${encodeURIComponent(saved.eventId)}?$select=id,isOnlineMeeting,onlineMeetingProvider,onlineMeeting`);
        if (response.status === 200) return remember(calendarResult(saved, await responseJSON(response)));
        await response.body?.cancel();
      }
      return remember(calendarResult(saved));
    } catch {
      if (saved.status === 'created') return remember(calendarResult(saved));
      return { ok: false, error: graphError() };
    }
  }
  handler({ job, authorize, client, requestText, resolvedAttendees, scrub = text => text }) {
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
        if (saved?.result?.ok) {
          job.teamsActionsAttempted = true;
          job.teamsMeeting = saved.result;
          return { ...saved.result, reused: true };
        }
        if (saved?.status === 'created') job.teamsMeeting = saved.result || calendarResult(saved);
        let attendees;
        if (!saved) {
          try { attendees = resolvedAttendees ?? await resolveMeetingAttendees(args.attendees, { client, requestText, signal }); }
          catch (error) { if (signal?.aborted) throw signal.reason; return { ok: false, error: error.message }; }
        }
        let token;
        try { token = await this.auth.token(); }
        catch { return { ok: false, error: 'Teams organizer sign-in is unavailable or expired. An admin must run npm run teams:login.' }; }
        signal?.throwIfAborted();
        if (job.cancelled || !this.auth.ready() || !(await authorize()) || token.organizer.homeAccountId !== organizer.homeAccountId) return { ok: false, error: 'Meeting creation stopped because access or the organizer changed.' };
        if (!saved) {
          const meeting = validateMeeting(args, this.now());
          saved = attendees.length ? { kind: 'calendar', status: 'pending', body: {
            subject: meeting.subject, start: { dateTime: meeting.startDateTime.replace(/Z$/, ''), timeZone: 'UTC' },
            end: { dateTime: meeting.endDateTime.replace(/Z$/, ''), timeZone: 'UTC' }, attendees,
            isOnlineMeeting: true, onlineMeetingProvider: 'teamsForBusiness', transactionId: `slack-agentic-${id}`,
          } } : { kind: 'link', body: { ...meeting, externalId: `slack-agentic-${id}` }, status: 'pending' };
          atomicJSON(file, saved);
        }
        job.teamsActionsAttempted = true;
        job.phase = 'Creating the Teams meeting';
        if (saved.kind === 'calendar') return this.calendarMeeting(saved, file, token, { signal, job,
          checkAccess: async () => !job.cancelled && this.auth.ready() && await authorize() && this.auth.organizer().homeAccountId === organizer.homeAccountId });
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
  if (!meeting) return answer;
  // Calendar writes have a deterministic receipt, including partial success.
  // The model cannot replace a missing join URL with an invented one.
  if (meeting.calendar_event_created) return [
    meeting.ok ? 'The Teams calendar meeting was created.' : meeting.error,
    ...(meeting.join_url ? [`[Join the Teams meeting](${meeting.join_url})`] : []),
    `Invitations submitted to Microsoft for: ${meeting.attendees.join(', ')}.`,
    ...(meeting.ok ? [`Time: ${meeting.starts_at} to ${meeting.ends_at} (UTC).`] : []),
  ].join('\n\n');
  if (!meeting.ok || answer.includes(meeting.join_url)) return answer;
  return `${answer}\n\n[Join the Teams meeting](${meeting.join_url})\nNo calendar invitation was sent.`.trim();
}
