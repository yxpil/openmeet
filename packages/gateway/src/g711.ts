/**
 * ITU-T G.711 μ-law / A-law companding.
 *
 * The decoders follow the reference structure reproduced by Asterisk, SpanDSP and
 * FFmpeg; the encoders are derived as the exact inverse of the decoders here, so the
 * round-trip test (encode(decode(c)) === c for all 256 codes) is a self-consistency
 * proof, and the published anchors below pin the absolute scale:
 *   μ-law full scale  ±32124, silence code 0xFF
 *   A-law  full scale ±32256, silence code 0xD5 (decodes to +8)
 */

const QUANT_MASK = 0x0f;
const SEG_MASK = 0x70;
const SEG_SHIFT = 4;
const SIGN_BIT = 0x80;
const ULAW_BIAS = 0x84;

export const ULAW_SILENCE = 0xff;
export const ALAW_SILENCE = 0xd5;
export const ULAW_FULL_SCALE = 32124;
export const ALAW_FULL_SCALE = 32256;

/** Wire code -> 16-bit linear sample. */
export function ulawDecode(code: number): number {
  const value = (~code) & 0xff;
  const segment = (value & SEG_MASK) >> SEG_SHIFT;
  let t = (((value & QUANT_MASK) << 3) + ULAW_BIAS) << segment;
  t -= ULAW_BIAS;
  return value & SIGN_BIT ? -t : t;
}

/** 16-bit linear sample -> wire code. */
export function ulawEncode(linear: number): number {
  const negative = linear < 0;
  const magnitude = Math.min(ULAW_FULL_SCALE, Math.abs(linear));
  let segment = 0;
  while (segment < 7 && magnitude > ulawSegmentMax(segment)) segment += 1;
  // D(q, s) = (8q + BIAS) * 2^s - BIAS  =>  q = ((L + BIAS) / 2^s - BIAS) / 8
  const q = clamp(Math.round(((magnitude + ULAW_BIAS) / (1 << segment) - ULAW_BIAS) / 8), 0, QUANT_MASK);
  const value = (negative ? SIGN_BIT : 0) | (segment << SEG_SHIFT) | q;
  return (~value) & 0xff;
}

function ulawSegmentMax(segment: number): number {
  return ((QUANT_MASK << 3) + ULAW_BIAS) * (1 << segment) - ULAW_BIAS;
}

/** Wire code -> 16-bit linear sample. */
export function alawDecode(code: number): number {
  const value = code ^ 0x55;
  const segment = (value & SEG_MASK) >> SEG_SHIFT;
  let t = (value & QUANT_MASK) << 4;
  if (segment === 0) {
    t += 8;
  } else {
    t = (t + 0x108) << (segment - 1);
  }
  return value & SIGN_BIT ? t : -t;
}

/** 16-bit linear sample -> wire code. */
export function alawEncode(linear: number): number {
  const negative = linear < 0;
  const magnitude = Math.min(ALAW_FULL_SCALE, Math.abs(linear));
  let segment = 0;
  let q: number;
  if (magnitude <= 248) {
    q = clamp(Math.round((magnitude - 8) / 16), 0, QUANT_MASK);
  } else {
    while (segment < 7 && magnitude > alawSegmentMax(segment)) segment += 1;
    q = clamp(Math.round((magnitude / (1 << (segment - 1)) - 0x108) / 16), 0, QUANT_MASK);
  }
  const value = (negative ? 0 : SIGN_BIT) | (segment << SEG_SHIFT) | q;
  return value ^ 0x55;
}

function alawSegmentMax(segment: number): number {
  if (segment === 0) return 248;
  return ((QUANT_MASK << 4) + 0x108) * (1 << (segment - 1));
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Decode a μ-law payload into Int16 PCM. */
export function ulawToPcm(payload: Uint8Array): Int16Array {
  const pcm = new Int16Array(payload.length);
  for (let i = 0; i < payload.length; i += 1) pcm[i] = ulawDecode(payload[i] as number);
  return pcm;
}

/** Encode Int16 PCM into a μ-law payload. */
export function pcmToUlaw(pcm: Int16Array): Uint8Array {
  const payload = new Uint8Array(pcm.length);
  for (let i = 0; i < pcm.length; i += 1) payload[i] = ulawEncode(pcm[i] as number);
  return payload;
}

/** Decode an A-law payload into Int16 PCM. */
export function alawToPcm(payload: Uint8Array): Int16Array {
  const pcm = new Int16Array(payload.length);
  for (let i = 0; i < payload.length; i += 1) pcm[i] = alawDecode(payload[i] as number);
  return pcm;
}

/** Encode Int16 PCM into an A-law payload. */
export function pcmToAlaw(pcm: Int16Array): Uint8Array {
  const payload = new Uint8Array(pcm.length);
  for (let i = 0; i < pcm.length; i += 1) payload[i] = alawEncode(pcm[i] as number);
  return payload;
}
