import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  combineDateTime,
  defaultScheduleWhen,
  formatRemaining,
  localDateString
} from '../src/renderer/src/lib/format';

describe('scheduled join date helpers', () => {
  it('builds a local-time instant from separate date and time fields', () => {
    const at = combineDateTime('2026-03-08', '21:30');
    const date = new Date(at);
    assert.equal(date.getFullYear(), 2026);
    assert.equal(date.getMonth(), 2);
    assert.equal(date.getDate(), 8);
    assert.equal(date.getHours(), 21);
    assert.equal(date.getMinutes(), 30);
    assert.equal(date.getSeconds(), 0);
    assert.equal(date.getMilliseconds(), 0);
  });

  it('treats midnight as a real time instead of a missing value', () => {
    const date = new Date(combineDateTime('2026-06-01', '00:00'));
    assert.equal(date.getHours(), 0);
    assert.equal(date.getMinutes(), 0);
  });

  it('rejects incomplete input rather than guessing', () => {
    assert.ok(Number.isNaN(combineDateTime('', '10:00')));
    assert.ok(Number.isNaN(combineDateTime('2026-06-01', '')));
    assert.ok(Number.isNaN(combineDateTime('2026-06-01', '10')));
  });

  it('prefills a moment that is strictly in the future', () => {
    const now = Date.now();
    const when = defaultScheduleWhen(now);
    assert.equal(when.date, localDateString(now + 60 * 60 * 1000));
    assert.ok(combineDateTime(when.date, when.time) > now);
  });

  it('keeps the countdown readable and never negative', () => {
    assert.equal(formatRemaining(90_000), '1 分 30 秒后');
    assert.equal(formatRemaining(3_600_000), '1 小时 0 分钟后');
    assert.equal(formatRemaining(90_061_000), '1 天 1 小时后');
    assert.equal(formatRemaining(800), '即将入会');
    assert.equal(formatRemaining(-5_000), '即将入会');
  });
});
