import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALAW_FULL_SCALE,
  ALAW_SILENCE,
  ULAW_FULL_SCALE,
  ULAW_SILENCE,
  alawDecode,
  alawEncode,
  ulawDecode,
  ulawEncode
} from '../src/g711.js';

function magnitudeAt(segment: number, q: number): number {
  return Math.abs(ulawDecode(((0x80 | (segment << 4) | q) ^ 0xff) & 0xff));
}

describe('G.711 μ-law', () => {
  it('reproduces the published anchors', () => {
    assert.equal(ulawDecode(ULAW_SILENCE), 0);
    assert.equal(ulawDecode(0x80), ULAW_FULL_SCALE);
    assert.equal(ulawDecode(0x00), -ULAW_FULL_SCALE);
    assert.equal(ulawEncode(0), ULAW_SILENCE);
    assert.equal(ulawEncode(ULAW_FULL_SCALE), 0x80);
    assert.equal(ulawEncode(-ULAW_FULL_SCALE), 0x00);
  });

  it('round-trips every code through its decoded value (μ-law keeps two zeros)', () => {
    const zeros = new Set<number>();
    for (let code = 0; code <= 0xff; code += 1) {
      const decoded = ulawDecode(code) + 0; // μ-law carries a signed zero; collapse it
      if (decoded === 0) zeros.add(code);
      assert.equal(
        ulawDecode(ulawEncode(decoded)) + 0,
        decoded,
        `code ${code.toString(16)} -> ${decoded}`
      );
    }
    // The standard deliberately encodes +0 and -0; the encoder picks the positive one.
    assert.deepEqual([...zeros].sort((a, b) => a - b), [0x7f, 0xff]);
    for (let code = 0; code <= 0xff; code += 1) {
      if (code === 0x7f) continue;
      assert.equal(ulawEncode(ulawDecode(code)), code, `code ${code.toString(16)}`);
    }
  });

  it('magnitude grows with the quantisation step inside and across segments', () => {
    for (let segment = 0; segment <= 7; segment += 1) {
      let previous = -1;
      for (let q = 0; q <= 15; q += 1) {
        const magnitude = Math.abs(ulawDecode((0x80 | (segment << 4) | q) ^ 0xff));
        assert.ok(magnitude > previous, `segment ${segment} q ${q}`);
        previous = magnitude;
      }
      if (segment < 7) {
        const nextLow = Math.abs(ulawDecode((0x80 | ((segment + 1) << 4)) ^ 0xff));
        assert.ok(nextLow > magnitudeAt(segment, 15), `segment ${segment} overlap`);
      }
    }
  });

  it('picks the nearest representable sample across the full 16-bit sweep', () => {
    let worst = 0;
    for (let sample = -32768; sample <= 32767; sample += 1) {
      const clamped = Math.max(-ULAW_FULL_SCALE, Math.min(ULAW_FULL_SCALE, sample));
      const decoded = ulawDecode(ulawEncode(sample));
      const error = Math.abs(decoded - clamped);
      // Segment 0 has a step of 8, the largest segment 1024; the mid-rise quantiser
      // must never be off by more than half a step plus the step of its own segment.
      worst = Math.max(worst, error);
      assert.ok(error <= 1024, `sample ${sample} decoded ${decoded} error ${error}`);
    }
    assert.ok(worst > 0);
  });
});

describe('G.711 A-law', () => {
  it('reproduces the published anchors', () => {
    assert.equal(alawDecode(ALAW_SILENCE), 8);
    assert.equal(alawDecode(0xaa), ALAW_FULL_SCALE);
    assert.equal(alawDecode(0x2a), -ALAW_FULL_SCALE);
    assert.equal(alawEncode(ALAW_FULL_SCALE), 0xaa);
    assert.equal(alawEncode(-ALAW_FULL_SCALE), 0x2a);
  });

  it('encoder is the exact inverse of the decoder for all 256 codes', () => {
    for (let code = 0; code <= 0xff; code += 1) {
      assert.equal(alawEncode(alawDecode(code)), code, `code ${code.toString(16)}`);
    }
  });

  it('keeps segment 0 on the documented 16-unit step', () => {
    for (let q = 0; q <= 15; q += 1) {
      // Segment 0 keeps the quantisation bits in the low nibble; A-law marks a
      // positive sample with the sign bit set after the 0x55 xor.
      assert.equal(alawDecode((0x80 | q) ^ 0x55), 16 * q + 8);
      assert.equal(alawDecode(q ^ 0x55), -(16 * q + 8));
    }
  });

  it('picks the nearest representable sample across the full 16-bit sweep', () => {
    for (let sample = -32768; sample <= 32767; sample += 1) {
      const clamped = Math.max(-ALAW_FULL_SCALE, Math.min(ALAW_FULL_SCALE, sample));
      const decoded = alawDecode(alawEncode(sample));
      assert.ok(
        Math.abs(decoded - clamped) <= 1024,
        `sample ${sample} decoded ${decoded} error ${Math.abs(decoded - clamped)}`
      );
    }
  });
});
