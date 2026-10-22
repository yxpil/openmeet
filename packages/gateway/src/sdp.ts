/**
 * Minimal SDP model for the SIP leg of the gateway.
 *
 * Only what a telephony bridge needs: audio sections, payload types with their
 * rtpmap/fmtp, direction, and the connection address (session or media level).
 * Unknown lines are preserved verbatim so an answer never silently drops
 * information a remote endpoint depends on.
 */

export interface SdpMedia {
  type: string;
  port: number;
  protocol: string;
  payloads: number[];
  rtpmap: Record<string, string>;
  fmtp: Record<string, string>;
  direction: 'sendrecv' | 'sendonly' | 'recvonly' | 'inactive';
  connectionIp: string | null;
  attributes: [string, string | null][];
  iceCandidates: string[];
  setup: string | null;
  mid: string | null;
}

export interface Sdp {
  version: number;
  origin: string;
  sessionName: string;
  timing: string;
  connectionIp: string | null;
  media: SdpMedia[];
  sessionAttributes: [string, string | null][];
  raw: string;
}

export interface AudioCodecSelection {
  payloadType: number;
  encodingName: string;
  clockRate: number;
  channels: number;
  fmtp?: string;
}

export function parseSdp(raw: string): Sdp {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const session: Sdp = {
    version: 0,
    origin: '',
    sessionName: '-',
    timing: '0 0',
    connectionIp: null,
    media: [],
    sessionAttributes: [],
    raw
  };

  let current: SdpMedia | null = null;
  for (const line of lines) {
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (key === 'm') {
      const [type, port, protocol, ...payloads] = value.split(/\s+/);
      current = {
        type: type ?? 'audio',
        port: Number(port) || 0,
        protocol: protocol ?? 'RTP/AVP',
        payloads: payloads.map(Number).filter((item) => Number.isFinite(item)),
        rtpmap: {},
        fmtp: {},
        direction: 'sendrecv',
        connectionIp: null,
        attributes: [],
        iceCandidates: [],
        setup: null,
        mid: null
      };
      session.media.push(current);
      continue;
    }
    if (key === 'v') session.version = Number(value) || 0;
    else if (key === 'o') session.origin = value;
    else if (key === 's') session.sessionName = value;
    else if (key === 't') session.timing = value;
    else if (key === 'c') {
      const ip = value.split(/\s+/).pop() ?? null;
      if (current) current.connectionIp = ip;
      else session.connectionIp = ip;
      continue;
    }

    if (!current) {
      if (key === 'a') session.sessionAttributes.push(attribute(value));
      continue;
    }

    if (key === 'a') {
      const [name, params] = attribute(value);
      current.attributes.push([name, params]);
      if (name === 'rtpmap' && params) {
        const [payload, ...rest] = params.split(' ');
        const value = rest.join(' ') ?? params;
        if (payload) current.rtpmap[payload] = value || params;
      } else if (name === 'fmtp' && params) {
        const index = params.indexOf(' ');
        if (index > 0) current.fmtp[params.slice(0, index)] = params.slice(index + 1);
      } else if (name === 'candidate') {
        current.iceCandidates.push(params ?? '');
      } else if (name === 'setup') {
        current.setup = params ?? null;
      } else if (name === 'mid') {
        current.mid = params ?? null;
      } else if (
        name === 'sendrecv' ||
        name === 'sendonly' ||
        name === 'recvonly' ||
        name === 'inactive'
      ) {
        current.direction = name;
      }
      continue;
    }
  }

  return session;
}

function attribute(value: string): [string, string | null] {
  const colon = value.indexOf(':');
  if (colon < 0) return [value, null];
  return [value.slice(0, colon), value.slice(colon + 1)];
}

/** Audio codecs the remote can receive, in the order it offered them. */
export function offeredCodecs(sdp: Sdp): AudioCodecSelection[] {
  const media = sdp.media.find((item) => item.type === 'audio');
  if (!media) return [];
  const result: AudioCodecSelection[] = [];
  for (const payload of media.payloads) {
    const mapping = media.rtpmap[String(payload)];
    if (mapping) {
      const [encodingName, clockRate, channels] = mapping.split('/');
      result.push({
        payloadType: payload,
        // 'telephone-event' and 'TELEPHONE_EVENT' name the same codec; match one form.
        encodingName: (encodingName ?? '').toUpperCase().replace(/[-\s]/g, '_'),
        clockRate: Number(clockRate) || 8000,
        channels: Number(channels) || 1,
        fmtp: media.fmtp[String(payload)]
      });
    } else {
      const staticCodec = STATIC_PAYLOADS.get(payload);
      if (staticCodec) {
        result.push({ payloadType: payload, encodingName: staticCodec[0], clockRate: 8000, channels: 1 });
      }
    }
  }
  return result;
}

export const STATIC_PAYLOADS = new Map<number, [string, number]>([
  [0, ['PCMU', 8000]],
  [1, ['GSM', 8000]],
  [2, ['G726-32', 8000]],
  [3, ['G723', 8000]],
  [4, ['G726-16', 8000]],
  [5, ['DVI4', 8000]],
  [6, ['DVI4', 16000]],
  [7, ['L16', 44100]],
  [8, ['PCMA', 8000]],
  [9, ['G722', 8000]],
  [10, ['L16', 44100]],
  [11, ['TELEPHONE_EVENT', 8000]],
  [13, ['CN', 8000]],
  [18, ['G729', 8000]]
]);

export interface BuildAudioSdpOptions {
  port: number;
  address: string;
  codecs: { payloadType: number; encodingName: string; clockRate: number; channels?: number; fmtp?: string }[];
  sessionName?: string;
  direction?: SdpMedia['direction'];
  ice?: { username: string; password: string; candidates: string[]; completion: boolean };
  setup?: 'actpass' | 'active' | 'passive';
  mid?: string;
}

/** Build a single audio m-section SDP for the SIP side. */
export function buildAudioSdp(options: BuildAudioSdpOptions): string {
  const lines = [
    'v=0',
    `o=- ${Date.now()} 1 IN IP4 ${options.address}`,
    `s=${options.sessionName ?? 'openmeet'}`,
    't=0 0',
    `c=IN IP4 ${options.address}`
  ];
  if (options.ice) {
    lines.push('a=ice-lite');
    for (const candidate of options.ice.candidates) lines.push(`a=candidate:${candidate}`);
    if (options.ice.completion) lines.push('a=end-of-candidates');
  }
  const payloads = options.codecs.map((codec) => codec.payloadType).join(' ');
  lines.push(`m=audio ${options.port} RTP/AVP ${payloads}`);
  if (options.mid) lines.push(`a=mid:${options.mid}`);
  for (const codec of options.codecs) {
    const channels = codec.channels && codec.channels > 1 ? `/${codec.channels}` : '';
    lines.push(`a=rtpmap:${codec.payloadType} ${codec.encodingName}/${codec.clockRate}${channels}`);
    if (codec.fmtp) lines.push(`a=fmtp:${codec.payloadType} ${codec.fmtp}`);
  }
  if (options.setup) lines.push(`a=setup:${options.setup}`);
  if (options.ice) {
    lines.push(`a=ice-ufrag:${options.ice.username}`);
    lines.push(`a=ice-pwd:${options.ice.password}`);
  }
  lines.push(`a=${options.direction ?? 'sendrecv'}`);
  return `${lines.join('\r\n')}\r\n`;
}

/** Rewrite the payload list of an audio section to the codec we selected. */
export function pickAudioSection(sdp: Sdp): SdpMedia | null {
  return sdp.media.find((item) => item.type === 'audio') ?? null;
}
