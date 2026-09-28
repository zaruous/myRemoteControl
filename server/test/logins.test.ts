import test from 'node:test';
import assert from 'node:assert/strict';
import { LoginManager } from '../src/logins.js';

function setup() {
  let now = 1_000_000, version = 'v1';
  const m = new LoginManager({ ttlMs: 60_000, idleMs: 10_000, version: () => version, now: () => now });
  const sock = () => { const s = { closed: 0, close(code: number) { s.closed = code; } }; return s; };
  return { m, sock, tick: (ms: number) => { now += ms; }, setVersion: (v: string) => { version = v; } };
}

test('발급한 토큰은 유효하고 절대 만료(TTL) 후에는 거부', () => {
  const { m, sock, tick } = setup();
  const l = m.issue('ua');
  assert.equal(m.check(l.token)?.id, l.id);
  m.attach(l, sock());           // 연결 중이어도 TTL은 절대 만료
  tick(60_001);
  assert.equal(m.check(l.token), null);
  assert.equal(m.check('nope'), null);
  assert.equal(m.check(undefined), null);
});

test('연결 없이 유휴 시간이 지나면 만료, 연결 중이면 유지', () => {
  const { m, sock, tick } = setup();
  const l = m.issue('ua');
  tick(9_000); assert.ok(m.check(l.token));        // HTTP 활동이 lastSeen 갱신
  tick(9_000); assert.ok(m.check(l.token));
  const s = sock(); m.attach(l, s);
  tick(30_000); assert.ok(m.check(l.token));       // WS 연결 중에는 유휴 아님
  m.detach(l, s);
  tick(10_001); assert.equal(m.check(l.token), null);
});

test('기기 로그아웃은 해당 토큰의 WS만 4401로 닫음', () => {
  const { m, sock } = setup();
  const a = m.issue('phone'), b = m.issue('pc');
  const sa = sock(), sb = sock();
  m.attach(a, sa); m.attach(b, sb);
  assert.equal(m.revoke(a.id), true);
  assert.equal(sa.closed, 4401);
  assert.equal(sb.closed, 0);
  assert.equal(m.check(a.token), null);
  assert.ok(m.check(b.token));
  assert.equal(m.revoke('없는id'), false);
});

test('전체 로그아웃', () => {
  const { m, sock } = setup();
  const s = sock(); m.attach(m.issue('a'), s); m.issue('b');
  m.revokeAll();
  assert.equal(s.closed, 4401);
  assert.deepEqual(m.list(), []);
});

test('인증 파일이 바뀌면(setup 재실행) 기존 토큰 무효, sweep이 열린 WS도 닫음', () => {
  const { m, sock, setVersion } = setup();
  const l = m.issue('ua'); const s = sock(); m.attach(l, s);
  setVersion('v2');
  m.sweep();
  assert.equal(s.closed, 4401);
  assert.equal(m.check(l.token), null);
});

test('sweep이 TTL 만료된 로그인의 WS를 닫음', () => {
  const { m, sock, tick } = setup();
  const l = m.issue('ua'); const s = sock(); m.attach(l, s);
  tick(60_001); m.sweep();
  assert.equal(s.closed, 4401);
});

test('목록에는 토큰이 노출되지 않음', () => {
  const { m, sock } = setup();
  const l = m.issue('Mozilla/5.0'); m.attach(l, sock());
  const [row] = m.list();
  assert.equal(row.id, l.id);
  assert.equal(row.sockets, 1);
  assert.ok(!JSON.stringify(m.list()).includes(l.token));
});
