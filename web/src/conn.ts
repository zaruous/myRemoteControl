// 세션 하나당 WebSocket 하나. 재접속 시 "지금까지 받은 누적 오프셋"을 resume으로 보내 끊긴 구간을 복구한다.
export type ConnState = 'connecting' | 'open' | 'waiting';

interface Handlers {
  write(d: string): void;
  reset(): void;
  size(): { cols: number; rows: number };
  onState(s: ConnState): void;
  onExit(code: number): void;
  onAuthExpired(): void;
  onGone(): void;
}

const BASE_MS = 500, CAP_MS = 15_000;
const PING_MS = 10_000, DEAD_MS = 20_000; // 20초간 아무 수신 없으면 half-open으로 간주

export class ResumableSocket {
  private offset = 0;
  private ws?: WebSocket;
  private attempt = 0;
  private retryTimer?: number;
  private pingTimer?: number;
  private lastRx = 0;
  private disposed = false;

  constructor(private readonly sessionId: string, private readonly h: Handlers) {
    window.addEventListener('online', this.kick);
    document.addEventListener('visibilitychange', this.onVisible);
    this.connect();
  }

  /** 끊겨 있으면 false. 입력을 큐잉하지 않는 이유: 늦게 도착한 Enter/Ctrl+C가 엉뚱한 시점에 실행되면 위험 */
  send(msg: object): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  dispose() {
    this.disposed = true;
    window.removeEventListener('online', this.kick);
    document.removeEventListener('visibilitychange', this.onVisible);
    clearTimeout(this.retryTimer);
    this.drop(false);
  }

  private connect() {
    const { cols, rows } = this.h.size();
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const q = new URLSearchParams({ session: this.sessionId, resume: String(this.offset), cols: String(cols), rows: String(rows) });
    const ws = new WebSocket(`${proto}//${location.host}/ws?${q}`);
    this.ws = ws;
    this.h.onState('connecting');

    ws.onopen = () => {
      this.attempt = 0;
      this.lastRx = Date.now();
      this.h.onState('open');
      this.pingTimer = window.setInterval(() => {
        if (Date.now() - this.lastRx > DEAD_MS) return this.drop(true);
        this.send({ t: 'ping', id: Date.now() });
      }, PING_MS);
    };
    ws.onmessage = e => {
      this.lastRx = Date.now();
      const m = JSON.parse(e.data);
      if (m.t === 'out') {
        if (m.reset) { this.h.reset(); this.offset = m.s; }       // 버퍼에서 밀려난 구간이 있음 → 화면 초기화 후 남은 것만
        else if (m.s !== this.offset) return this.drop(true);      // 불연속(이론상 없음) → 재접속으로 교정
        this.h.write(m.d);
        this.offset += m.d.length;
      } else if (m.t === 'exit') this.h.onExit(m.code);
    };
    ws.onclose = e => {
      if (this.ws !== ws) return;          // 이미 drop으로 떼어낸 소켓
      this.clearSocket();
      if (e.code === 4401) return this.h.onAuthExpired();
      if (e.code === 4404) return this.h.onGone();
      this.schedule();
    };
  }

  /** CLOSING 상태에서 수십 초 멈추는 half-open 소켓을 기다리지 않고 즉시 버리고 새로 연결 */
  private drop(reconnect: boolean) {
    const ws = this.ws;
    this.clearSocket();
    if (ws) { ws.onopen = ws.onmessage = ws.onclose = null; try { ws.close(); } catch { /* ignore */ } }
    if (reconnect) this.schedule();
  }

  private clearSocket() {
    clearInterval(this.pingTimer);
    this.ws = undefined;
  }

  // Exponential backoff + full jitter
  private schedule() {
    if (this.disposed) return;
    clearTimeout(this.retryTimer);
    const delay = Math.random() * Math.min(CAP_MS, BASE_MS * 2 ** this.attempt++);
    this.h.onState('waiting');
    this.retryTimer = window.setTimeout(async () => {
      // 핸드셰이크 401은 브라우저에서 1006으로만 보여서 구분 불가 → 몇 번 실패하면 HTTP로 인증 상태 확인
      if (this.attempt > 2) {
        const st = await fetch('/api/sessions').then(r => r.status).catch(() => 0);
        if (st === 401) return this.h.onAuthExpired();
      }
      if (!this.disposed) this.connect();
    }, delay);
  }

  private kick = () => {
    if (this.ws || this.disposed) return; // 연결(시도) 중이면 그대로
    this.attempt = 0;
    clearTimeout(this.retryTimer);
    this.connect();
  };

  // 모바일에서 백그라운드 복귀 시: 소켓이 살아 보여도 죽어 있는 경우가 많아 즉시 검증
  private onVisible = () => {
    if (document.visibilityState !== 'visible') return;
    if (!this.ws) return this.kick();
    if (Date.now() - this.lastRx > PING_MS) {
      this.send({ t: 'ping', id: Date.now() });
      const probeStart = Date.now();
      setTimeout(() => { if (this.lastRx < probeStart) this.drop(true); }, 3000);
    }
  };
}
