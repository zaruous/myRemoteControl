import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import * as pty from 'node-pty';
import { RingBuffer } from './ringBuffer.js';

export interface Session {
  id: string;
  title: string;
  pty: pty.IPty;
  buf: RingBuffer;
  exitCode: number | null;
  events: EventEmitter; // 'data'(data, start), 'exit'(code)
  createdAt: number;
  shellStart?: string;  // 셸 프로세스 시작 시각(ps lstart). PID 재사용 판별용
  clients: number;      // 접속 중인 WebSocket 수
}

const KILL_GRACE_MS = 2000; // SIGTERM 후 SIGKILL까지 유예

type Proc = { ppid: number; sid: number; start: string };

/** 전체 프로세스 스냅샷. sid는 Linux에서만(macOS ps에는 sid 키워드 없음) */
function snapshot(): Map<number, Proc> {
  const linux = process.platform === 'linux';
  const out = execFileSync('ps', ['-A', '-o', linux ? 'pid=,ppid=,sid=,lstart=' : 'pid=,ppid=,lstart='], { encoding: 'utf8' });
  const m = new Map<number, Proc>();
  for (const line of out.split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 3) continue;
    m.set(Number(f[0]), { ppid: Number(f[1]), sid: linux ? Number(f[2]) : -1, start: f.slice(linux ? 3 : 2).join(' ') });
  }
  return m;
}

/** 세션에 속한 PID: 셸과 그 자손 + (Linux) 셸이 리더인 세션의 구성원. setsid로 떠난 프로세스는 못 잡음 */
function sessionPids(s: Session, procs: Map<number, Proc>): number[] {
  const root = s.pty.pid;
  const rootNow = procs.get(root);
  if (rootNow && rootNow.start !== s.shellStart) return []; // PID가 다른 프로세스에 재사용됨 → 건드리지 않음
  const found = new Set([root]);
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, p] of procs) {
      if (!found.has(pid) && (found.has(p.ppid) || p.sid === root)) { found.add(pid); grew = true; }
    }
  }
  found.delete(process.pid); found.delete(1);
  return [...found].filter(pid => procs.has(pid));
}

function signal(pids: number[], sig: NodeJS.Signals) {
  for (const pid of pids) { try { process.kill(pid, sig); } catch { /* 이미 종료 */ } }
}

export class SessionManager {
  private sessions = new Map<string, Session>();
  private counter = 0;

  constructor(private readonly bufferChars: number) {}

  create(opts: { title?: string; cols?: number; rows?: number; shell?: string; args?: string[] } = {}): Session {
    const shell = opts.shell ?? (process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || 'bash');
    const p = pty.spawn(shell, opts.args ?? [], {
      name: 'xterm-256color',
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 24,
      cwd: os.homedir(),
      env: process.env as Record<string, string>,
    });
    const s: Session = {
      id: randomUUID(),
      title: opts.title || `tab ${++this.counter}`,
      pty: p,
      buf: new RingBuffer(this.bufferChars),
      exitCode: null,
      events: new EventEmitter(),
      createdAt: Date.now(),
      clients: 0,
    };
    try { s.shellStart = snapshot().get(p.pid)?.start; } catch { /* ps 없음 → 트리 종료 비활성 */ }
    s.events.setMaxListeners(0);
    // 클라이언트 유무와 무관하게 항상 버퍼에 적재 → 접속이 끊겨도 출력 유실 없음(버퍼 한도 내)
    p.onData(d => s.events.emit('data', d, s.buf.push(d)));
    p.onExit(({ exitCode }) => { s.exitCode = exitCode; s.events.emit('exit', exitCode); });
    this.sessions.set(s.id, s);
    return s;
  }

  get(id: string) { return this.sessions.get(id); }

  list() {
    return [...this.sessions.values()].map(s => ({
      id: s.id, title: s.title, exitCode: s.exitCode, createdAt: s.createdAt, clients: s.clients,
      pid: s.pty.pid, process: s.exitCode === null ? foreground(s) : null,
    }));
  }

  kill(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    // 셸이 죽으면 자식이 PID 1로 입양돼 추적이 끊기므로, 죽이기 전에 대상 목록을 먼저 확보
    let targets: [number, string][] = [];
    try {
      const procs = snapshot();
      targets = sessionPids(s, procs).map(pid => [pid, procs.get(pid)!.start]);
    } catch { /* ps 실패 → 셸에 SIGHUP만 (기존 동작) */ }
    if (s.exitCode === null) s.pty.kill();
    signal(targets.map(t => t[0]), 'SIGTERM');
    if (targets.length) {
      setTimeout(() => {
        let now: Map<number, Proc>;
        try { now = snapshot(); } catch { return; }
        // 같은 PID라도 시작 시각이 다르면 재사용된 무관한 프로세스 → 제외
        signal(targets.filter(([pid, start]) => now.get(pid)?.start === start).map(t => t[0]), 'SIGKILL');
      }, KILL_GRACE_MS).unref();
    }
    s.events.emit('closed');
    this.sessions.delete(id);
    return true;
  }
}

function foreground(s: Session): string | null {
  try { return s.pty.process; } catch { return null; }
}
