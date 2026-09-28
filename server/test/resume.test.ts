// 재현 테스트: 출력 도중 소켓을 강제 절단(half-open 유사) → 끊긴 동안의 출력까지 resume으로 누락·중복 없이 복구되는지
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { SessionManager } from '../src/sessions.js';
import { attachWs } from '../src/ws.js';

const ORIGIN = 'http://test';
async function setup(bufferChars: number) {
  const sessions = new SessionManager(bufferChars);
  const server = http.createServer();
  attachWs(server, sessions, () => Date.now() + 60_000, [ORIGIN]);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const open = (id: string, resume: number) =>
    new WebSocket(`ws://127.0.0.1:${port}/ws?session=${id}&resume=${resume}`, { headers: { origin: ORIGIN } });
  return { sessions, server, open };
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
