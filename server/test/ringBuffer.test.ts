import test from 'node:test';
import assert from 'node:assert/strict';
import { RingBuffer } from '../src/ringBuffer.js';

test('중간 오프셋부터 정확히 이어 읽기 (청크 경계 무관)', () => {
  const b = new RingBuffer(100);
  b.push('hello '); b.push('world');
  assert.deepEqual(b.readFrom(3), { start: 3, data: 'lo world', gap: false });
  assert.deepEqual(b.readFrom(11), { start: 11, data: '', gap: false });
});

test('밀려난 구간 요청 시 gap=true, 남은 데이터 전부', () => {
  const b = new RingBuffer(10);
  b.push('aaaaaa'); b.push('bbbbbb'); // 12 > 10 → 첫 청크 제거
  assert.equal(b.tail, 6);
  assert.deepEqual(b.readFrom(2), { start: 6, data: 'bbbbbb', gap: true });
});

test('미래 오프셋/비정상 값은 gap 처리', () => {
  const b = new RingBuffer(10);
  b.push('abc');
  assert.equal(b.readFrom(99).gap, true);
  assert.equal(b.readFrom(NaN).gap, true);
});
