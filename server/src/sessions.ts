import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
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
    };
    s.events.setMaxListeners(0);
    // 클라이언트 유무와 무관하게 항상 버퍼에 적재 → 접속이 끊겨도 출력 유실 없음(버퍼 한도 내)
    p.onData(d => s.events.emit('data', d, s.buf.push(d)));
    p.onExit(({ exitCode }) => { s.exitCode = exitCode; s.events.emit('exit', exitCode); });
    this.sessions.set(s.id, s);
    return s;
  }

  get(id: string) { return this.sessions.get(id); }

  list() {
    return [...this.sessions.values()].map(s => ({ id: s.id, title: s.title, exitCode: s.exitCode }));
  }

  kill(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    if (s.exitCode === null) s.pty.kill();
    s.events.emit('closed');
    this.sessions.delete(id);
    return true;
  }
}
