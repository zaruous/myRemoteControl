// 재현 테스트: 탭(세션) 종료 시 nohup·이중 fork로 떠난 자식까지 종료되는지
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { SessionManager } from '../src/sessions.js';

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const alive = (tag: string) => execFileSync('ps', ['-A', '-o', 'args=']).toString().split('\n').filter(l => l.includes(tag)).length;

test('세션 종료 시 nohup·이중 fork 자식까지 종료', async () => {
  const sm = new SessionManager(10_000);
  const s = sm.create({ shell: 'bash' });
  await wait(300);
  const tag = `${process.pid}${Date.now() % 100000}`;
  s.pty.write(`sleep 1${tag} &\n`);
  s.pty.write(`nohup sleep 2${tag} >/dev/null 2>&1 &\n`);
  s.pty.write(`(sleep 3${tag} &)\n`);           // 부모가 즉시 끝나 PID 1로 입양됨
  s.pty.write(`(trap '' TERM HUP; exec sleep 4${tag})\n`); // TERM·HUP 무시 → SIGKILL 단계 필요
  await wait(800);
  try { assert.equal(alive(tag), 4, '준비 실패'); } catch (e) { sm.kill(s.id); throw e; }
  assert.equal(sm.kill(s.id), true);
  for (let i = 0; i < 60 && alive(tag) > 0; i++) await wait(100);
  const left = alive(tag);
  if (left) execFileSync('pkill', ['-9', '-f', tag]);
  assert.equal(left, 0, '남은 프로세스 있음');
});

test('목록에 셸 PID와 포그라운드 프로세스 표시', async () => {
  const sm = new SessionManager(10_000);
  const s = sm.create({ shell: 'bash' });
  await wait(300);
  s.pty.write('sleep 5\n');
  await wait(500);
  try {
    const [row] = sm.list();
    assert.equal(row.pid, s.pty.pid);
    assert.equal(row.process, 'sleep');
    assert.equal(row.clients, 0);
  } finally { sm.kill(s.id); }
});
