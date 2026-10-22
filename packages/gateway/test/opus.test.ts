import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  FRAME_SAMPLES_48,
  FRAME_SAMPLES_8,
  OpusTranscoder,
  TELEPHONY_SAMPLE_RATE,
  WEBRTC_SAMPLE_RATE,
  mixPcm,
  resample
} from '../src/opus.js';
import { pcmToUlaw, ulawDecode, ulawToPcm } from '../src/g711.js';

/** Goertzel energy at a probe frequency. */
function toneEnergy(samples: Int16Array, frequency: number, sampleRate: number): number {
  const angular = (2 * Math.PI * frequency) / sampleRate;
  const coefficient = 2 * Math.cos(angular);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const s0 = (samples[i] ?? 0) + coefficient * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.sqrt(s1 * s1 + s2 * s2 - coefficient * s1 * s2);
}

function rms(samples: Int16Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) sum += (samples[i] ?? 0) ** 2;
  return Math.sqrt(sum / Math.max(1, samples.length));
}

function sine(frequency: number, sampleRate: number, samples: number, amplitude = 12000): Int16Array {
  const out = new Int16Array(samples);
  for (let i = 0; i < samples; i += 1) {
    out[i] = Math.round(amplitude * Math.sin((2 * Math.PI * frequency * i) / sampleRate));
  }
  return out;
}

describe('Opus transcoder', () => {
  it('keeps the pitch of a 440 Hz tone through encode -> decode', () => {
    const codec = new OpusTranscoder();
    try {
      const input = sine(440, WEBRTC_SAMPLE_RATE, FRAME_SAMPLES_48);
      const packet = codec.encode(input);
      assert.ok(packet.length > 0, 'encoder produced an empty packet');
      assert.ok(packet.length < 400, `packet suspiciously large: ${packet.length}`);
      const output = codec.decode(packet);
      assert.equal(output.length, FRAME_SAMPLES_48);
      const at440 = toneEnergy(output, 440, WEBRTC_SAMPLE_RATE);
      const at880 = toneEnergy(output, 880, WEBRTC_SAMPLE_RATE);
      assert.ok(at440 > at880 * 4, `440 Hz energy ${at440} not dominant over 880 Hz ${at880}`);
      assert.ok(rms(output) > 2000, `level collapsed: ${rms(output)}`);
    } finally {
      codec.destroy();
    }
  });

  it('rejects a frame that is not 20 ms at 48 kHz', () => {
    const codec = new OpusTranscoder();
    try {
      assert.throws(() => codec.encode(new Int16Array(160)), /960 samples/);
    } finally {
      codec.destroy();
    }
  });
});

describe('resampler', () => {
  it('preserves a telephony-band tone when decimating 48k -> 8k', () => {
    const tone = sine(400, WEBRTC_SAMPLE_RATE, FRAME_SAMPLES_48);
    const narrowband = resample(tone, WEBRTC_SAMPLE_RATE, TELEPHONY_SAMPLE_RATE);
    assert.equal(narrowband.length, FRAME_SAMPLES_8);
    const at400 = toneEnergy(narrowband, 400, TELEPHONY_SAMPLE_RATE);
    const at2000 = toneEnergy(narrowband, 2000, TELEPHONY_SAMPLE_RATE);
    assert.ok(at400 > at2000 * 10, `400 Hz ${at400} vs 2000 Hz ${at2000}`);
  });

  it('is a no-op at equal rates and interpolates back up', () => {
    const tone = sine(400, TELEPHONY_SAMPLE_RATE, FRAME_SAMPLES_8);
    assert.equal(resample(tone, TELEPHONY_SAMPLE_RATE, TELEPHONY_SAMPLE_RATE), tone);
    const up = resample(tone, TELEPHONY_SAMPLE_RATE, WEBRTC_SAMPLE_RATE);
    assert.equal(up.length, FRAME_SAMPLES_48);
    assert.ok(toneEnergy(up, 400, WEBRTC_SAMPLE_RATE) > toneEnergy(up, 3000, WEBRTC_SAMPLE_RATE));
  });
});

describe('mixer', () => {
  it('passes a single stream through untouched', () => {
    const only = sine(440, WEBRTC_SAMPLE_RATE, FRAME_SAMPLES_48);
    assert.equal(mixPcm([only]), only);
    assert.equal(mixPcm([]).length, 0);
  });

  it('averages two speakers and clamps instead of wrapping', () => {
    const a = new Int16Array([1000, -1000, 32767, -32768]);
    const b = new Int16Array([3000, -3000, 32767, -32768]);
    const mixed = mixPcm([a, b]);
    assert.deepEqual([...mixed], [2000, -2000, 32767, -32768]);
  });
});

describe('Opus -> G.711 leg', () => {
  it('keeps a telephony tone audible after the full transcode chain', () => {
    const codec = new OpusTranscoder();
    try {
      const tone = sine(300, WEBRTC_SAMPLE_RATE, FRAME_SAMPLES_48);
      const decoded = codec.decode(codec.encode(tone));
      const narrowband = resample(decoded, WEBRTC_SAMPLE_RATE, TELEPHONY_SAMPLE_RATE);
      const payload = pcmToUlaw(narrowband);
      assert.equal(payload.length, FRAME_SAMPLES_8);
      const back = ulawToPcm(payload);
      assert.equal(back.length, FRAME_SAMPLES_8);
      assert.equal(ulawDecode(payload[0] as number), back[0]);
      const at300 = toneEnergy(back, 300, TELEPHONY_SAMPLE_RATE);
      const at3000 = toneEnergy(back, 3000, TELEPHONY_SAMPLE_RATE);
      assert.ok(at300 > at3000 * 5, `300 Hz ${at300} vs 3000 Hz ${at3000}`);
      assert.ok(rms(back) > 1000, `level lost through the chain: ${rms(back)}`);
    } finally {
      codec.destroy();
    }
  });
});
