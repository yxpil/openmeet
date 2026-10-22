import Opus from 'opusscript';
import { RtpPacket } from 'werift';

/** WebRTC carries Opus at a 48 kHz RTP clock; telephony runs 8 kHz. */
export const WEBRTC_SAMPLE_RATE = 48000;
export const TELEPHONY_SAMPLE_RATE = 8000;
/** 20 ms frames, the convention for Opus-in-WebRTC and for G.711 alike. */
export const FRAME_MS = 20;
export const FRAME_SAMPLES_48 = (WEBRTC_SAMPLE_RATE * FRAME_MS) / 1000;
export const FRAME_SAMPLES_8 = (TELEPHONY_SAMPLE_RATE * FRAME_MS) / 1000;

const OPUS_APPLICATION_VOIP = 2048;

/**
 * Opus <-> 48 kHz mono PCM. The WebRTC leg always speaks 48 kHz Opus, so the
 * telephony leg resamples rather than re-configuring the codec.
 */
export class OpusTranscoder {
  private readonly encoder: Opus;
  private readonly decoder: Opus;

  constructor() {
    this.encoder = new Opus(WEBRTC_SAMPLE_RATE, 1, OPUS_APPLICATION_VOIP);
    this.decoder = new Opus(WEBRTC_SAMPLE_RATE, 1);
  }

  /** 960 samples of 48 kHz Int16 PCM -> one Opus packet. */
  encode(pcm: Int16Array): Buffer {
    if (pcm.length !== FRAME_SAMPLES_48) {
      throw new Error(`Opus encode expects ${FRAME_SAMPLES_48} samples, got ${pcm.length}`);
    }
    const input = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    return this.encoder.encode(input, FRAME_SAMPLES_48) as unknown as Buffer;
  }

  /** One Opus packet -> Int16 PCM at 48 kHz (960 samples for a 20 ms frame). */
  decode(payload: Uint8Array): Int16Array {
    const raw = this.decoder.decode(Buffer.from(payload));
    if (!raw || raw.byteLength === 0) return new Int16Array(0);
    return new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
  }

  destroy(): void {
    this.encoder.delete();
    this.decoder.delete();
  }
}

/**
 * Linear resampler. Decimation without a low-pass filter can alias when
 * down-sampling 48k -> 8k; speech bandwidth (300-3400 Hz) stays well below the
 * 4 kHz Nyquist limit, which is the trade-off for keeping the gateway free of
 * native DSP dependencies.
 */
export function resample(input: Int16Array, fromRate: number, toRate: number): Int16Array {
  if (fromRate === toRate) return input;
  const ratio = toRate / fromRate;
  const length = Math.max(1, Math.round(input.length * ratio));
  const output = new Int16Array(length);
  for (let i = 0; i < length; i += 1) {
    const position = i / ratio;
    const lower = Math.floor(position);
    const upper = Math.min(input.length - 1, lower + 1);
    const fraction = position - lower;
    const value = (input[lower] ?? 0) * (1 - fraction) + (input[upper] ?? 0) * fraction;
    output[i] = Math.max(-32768, Math.min(32767, Math.round(value)));
  }
  return output;
}

/**
 * Mix 48 kHz streams by averaging with saturation. Averaging keeps a loud
 * conference intelligible instead of clipping; a single stream passes through
 * untouched so the 1:1 case is bit-exact.
 */
export function mixPcm(streams: Int16Array[]): Int16Array {
  const active = streams.filter((stream) => stream.length > 0);
  if (active.length === 0) return new Int16Array(0);
  if (active.length === 1) return active[0] as Int16Array;
  const length = Math.max(...active.map((stream) => stream.length));
  const mixed = new Int16Array(length);
  for (let i = 0; i < length; i += 1) {
    let sum = 0;
    for (const stream of active) sum += stream[i] ?? 0;
    mixed[i] = Math.max(-32768, Math.min(32767, Math.round(sum / active.length)));
  }
  return mixed;
}

export function opusPayload(packet: RtpPacket): Uint8Array {
  return new Uint8Array(packet.payload.buffer, packet.payload.byteOffset, packet.payload.length);
}
