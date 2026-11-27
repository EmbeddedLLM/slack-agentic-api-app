const emailPattern = /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?)+$/i;
const slackIdPattern = /^[UW][A-Z0-9]+$/;
const asId = value => /^<@([UW][A-Z0-9]+)>$/.exec(value)?.[1] || value;
const validEmail = value => typeof value === 'string' && value.length <= 254 && emailPattern.test(value);

export function validateAttendees(attendees = []) {
  if (!Array.isArray(attendees) || attendees.length > 20 || attendees.some(value => typeof value !== 'string' || !(validEmail(value) || slackIdPattern.test(asId(value))))) {
    throw new Error('Provide up to 20 invitees as email addresses or exact Slack user IDs from mentions. Ask for an email address or @mention when a name is ambiguous.');
  }
  return attendees;
}

// Resolve only identifiers explicitly supplied in this request, never names or
// recipients suggested by retrieved documents, other people, or model history.
export async function resolveMeetingAttendees(attendees, { client, requestText = '', signal } = {}) {
  validateAttendees(attendees);
  const mentioned = new Set([...requestText.matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)].map(match => match[1]));
  const emails = new Set((requestText.match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []).map(value => value.toLowerCase()));
  const resolved = new Set();
  for (const raw of new Set(attendees || [])) {
    signal?.throwIfAborted();
    const value = asId(raw);
    if (slackIdPattern.test(value)) {
      if (!mentioned.has(value)) throw new Error('Ask the requester to @mention every invitee or provide their email addresses in this message. Do not guess recipients from names or conversation history.');
      let response;
      try { response = await client.users.info({ user: value }); } catch { /* Missing scope and unavailable profiles use the same safe fallback. */ }
      const user = response?.user;
      if (response?.ok !== true || user?.id !== value || user.deleted || user.is_bot || user.is_app_user || !validEmail(user.profile?.email)) {
        throw new Error(`Cannot resolve an email address for Slack user ${value}. Ask the requester for that person's email address. Slack @mention lookup requires users:read.email and a visible, active human profile. No meeting or invitations were created.`);
      }
      resolved.add(user.profile.email.toLowerCase());
    } else {
      if (!emails.has(value.toLowerCase())) throw new Error('Ask the requester to provide every invitee’s email address or @mention in this message. Never infer email addresses.');
      resolved.add(value.toLowerCase());
    }
  }
  return [...resolved].map(address => ({ emailAddress: { address }, type: 'required' }));
}
