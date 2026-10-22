/**
 * A gateway answers calls for every dial-in number, but sip.js follows
 * RFC 3261 §8.2.2.1 and rejects any request whose Request-URI user is not the
 * UA's own address of record. So the transport rewrites the request-line user to
 * the AOR before sip.js sees it, and remembers what was actually dialled under
 * the Call-ID for room routing.
 *
 * Only the request line is touched; headers and body travel unchanged.
 */

const CALLED_TTL_MS = 5 * 60 * 1000;
const CALLED_MAX = 1000;

const calledByCallId = new Map<string, { number: string; at: number }>();

export function rewriteRequestLine(line: string, aorUser: string): { line: string; called: string | null } {
  const match = /^([A-Z]{3,10}) sip:([^ ]+) (SIP\/2\.0)$/.exec(line);
  if (!match) return { line, called: null };
  const [, method, target, version] = match;
  const at = target.lastIndexOf('@');
  if (at < 0) return { line, called: null };
  const user = target.slice(0, at);
  const host = target.slice(at);
  if (!user || user === aorUser) return { line, called: user || null };
  return { line: `${method} sip:${aorUser}${host} ${version}`, called: user };
}

export function rememberCalledNumber(callId: string, number: string): void {
  if (!callId || !number) return;
  calledByCallId.set(callId, { number, at: Date.now() });
  if (calledByCallId.size <= CALLED_MAX) return;
  // Drop the oldest entries rather than growing without bound on a busy gateway.
  for (const key of [...calledByCallId.keys()].slice(0, calledByCallId.size - CALLED_MAX)) {
    calledByCallId.delete(key);
  }
}

export function takeCalledNumber(callId: string | undefined): string {
  if (!callId) return '';
  const entry = calledByCallId.get(callId);
  if (!entry) return '';
  if (Date.now() - entry.at > CALLED_TTL_MS) {
    calledByCallId.delete(callId);
    return '';
  }
  return entry.number;
}

export function extractCallId(message: string): string {
  for (const line of message.split('\r\n')) {
    if (line === '') break; // headers end at the blank line
    const match = /^call-id:\s*(.+)$/i.exec(line);
    if (match) return match[1].trim();
  }
  return '';
}
