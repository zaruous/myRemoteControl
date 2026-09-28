// 재현 테스트: 출력 도중 소켓을 강제 절단(half-open 유사) → 끊긴 동안의 출력까지 resume으로 누락·중복 없이 복구되는지
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { SessionManager } from '../src/sessions.js';
import { attachWs } from '../src/ws.js';
import { LoginManager } from '../src/logins.js';

const ORIGIN = 'http://test';
async function setup(bufferChars: number) {
  const sessions = new SessionManager(bufferChars);
  const server = http.createServer();
  const logins = new LoginManager({ ttlMs: 60_000, idleMs: 60_000, version: () => 'v' });
  const login = logins.issue('test');
  attachWs(server, sessions, req => logins.check(req.headers.cookie?.slice(3)), logins, [ORIGIN]);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const open = (id: string, resume: number) =>
    new WebSocket(`ws://127.0.0.1:${port}/ws?session=${id}&resume=${resume}`, { headers: { origin: ORIGIN, cookie: `wt=${login.token}` } });
  return { sessions, server, open, logins, login };
}
const N = 3000;
const script = `for i in $(seq 1 ${N}); do echo L$i; [ $((i%200)) = 0 ] && sleep 0.05; done; sleep 0.2`;

test('강제 절단 후 resume 시 전체 출력 연속 복구', async () => {
  const { sessions, server, open } = await setup(2_000_000);
  const s = sessions.create({ shell: 'bash', args: ['-c', script] });
  let offset = 0, text = '';
  const onOut = (m: any) => {
    assert.equal(m.s, offset, '오프셋 불연속');   // 누락/중복 감지
    assert.ok(!m.reset);
    text += m.d; offset += m.d.length;
  };

  // 1차 접속: 약간 받은 뒤 강제 절단
  await new Promise<void>(res => {
    const ws = open(s.id, 0);
    ws.on('message', raw => {
      const m = JSON.parse(raw.toString());
      if (m.t === 'out') onOut(m);
      if (text.includes('L300\r\n')) { ws.terminate(); res(); }
    });
  });
  const cutAt = offset;
  await new Promise(r => setTimeout(r, 300)); // 끊긴 동안에도 PTY는 계속 출력

  // 2차 접속: 마지막 오프셋으로 resume, exit까지 수신
  await new Promise<void>(res => {
    const ws = open(s.id, offset);
    ws.on('message', raw => {
      const m = JSON.parse(raw.toString());
      if (m.t === 'out') onOut(m);
      if (m.t === 'exit') { ws.close(); res(); }
    });
  });

  const lines = text.split('\r\n').filter(Boolean);
  assert.deepEqual(lines, Array.from({ length: N }, (_, i) => `L${i + 1}`));
  assert.ok(offset > cutAt);
  sessions.kill(s.id); server.close();
});

test('버퍼보다 오래 끊기면 reset 플래그로 알림', async () => {
  const { sessions, server, open } = await setup(1000);
  const s = sessions.create({ shell: 'bash', args: ['-c', script] });
  await new Promise<void>(r => s.events.once('exit', () => r()));
  const m = await new Promise<any>(res => open(s.id, 0).once('message', raw => res(JSON.parse(raw.toString()))));
  assert.equal(m.reset, true);
  assert.ok(m.s > 0 && m.d.length <= 1000 + 200);
  sessions.kill(s.id); server.close();
});

test('Origin 불일치 시 업그레이드 거부', async () => {
  const { sessions, server, open } = await setup(1000);
  const s = sessions.create({ shell: 'bash', args: ['-c', 'sleep 1'] });
  const ws = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws?session=${s.id}`, { headers: { origin: 'http://evil' } });
  const status = await new Promise<number>(res => ws.on('unexpected-response', (_q, r) => res(r.statusCode!)));
  assert.equal(status, 403);
  sessions.kill(s.id); server.close();
  void open;
});

test('로그아웃(토큰 폐기) 시 열린 WS가 4401로 닫힘', async () => {
  const { sessions, server, open, logins, login } = await setup(1000);
  const s = sessions.create({ shell: 'bash', args: ['-c', 'sleep 5'] });
  const ws = open(s.id, 0);
  await new Promise(r => ws.once('message', r));
  assert.equal(sessions.list()[0].clients, 1);
  const code = new Promise<number>(res => ws.once('close', c => res(c)));
  logins.revoke(login.id);
  assert.equal(await code, 4401);
  await new Promise(r => setTimeout(r, 50));
  assert.equal(sessions.list()[0].clients, 0);
  assert.equal(logins.list().length, 0);
  sessions.kill(s.id); server.close();
});

test('쿠키 없으면 업그레이드 401', async () => {
  const { sessions, server } = await setup(1000);
  const s = sessions.create({ shell: 'bash', args: ['-c', 'sleep 1'] });
  const ws = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws?session=${s.id}`, { headers: { origin: ORIGIN } });
  const status = await new Promise<number>(res => ws.on('unexpected-response', (_q, r) => res(r.statusCode!)));
  assert.equal(status, 401);
  sessions.kill(s.id); server.close();
});
