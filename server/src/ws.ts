import type { Server, IncomingMessage } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { SessionManager } from './sessions.js';
import type { Login, LoginManager } from './logins.js';

// 프로토콜 (JSON 텍스트 프레임)
//  S→C  {t:'out', s:<시작 오프셋>, d:<문자열>, reset?:true}   reset=버퍼에서 밀려난 구간 있음 → 클라가 화면 리셋
//  S→C  {t:'exit', code} | {t:'pong', id}
//  C→S  {t:'in', d} | {t:'resize', c, r} | {t:'ping', id}
// 재접속: /ws?session=<id>&resume=<마지막으로 받은 누적 오프셋>

const HEARTBEAT_MS = 25_000;          // Cloudflare 유휴 타임아웃(100s)보다 짧게
const MAX_BUFFERED = 1 << 20;         // 1MB 넘게 밀리면 끊고 resume으로 따라잡게 함
export const CLOSE = { AUTH: 4401, NO_SESSION: 4404, SLOW: 4408 } as const;

export function attachWs(
  server: Server,
  sessions: SessionManager,
  verify: (req: IncomingMessage) => Login | null,
  logins: Pick<LoginManager, 'attach' | 'detach'>,
  allowedOrigins: string[],
) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const reject = (code: number, msg: string) => { socket.end(`HTTP/1.1 ${code} ${msg}\r\n\r\n`); };
    if (url.pathname !== '/ws') return reject(404, 'Not Found');
    // 쿠키 인증 WS는 CSWSH에 취약 → Origin 화이트리스트 필수
    if (!allowedOrigins.includes(req.headers.origin ?? '')) return reject(403, 'Forbidden');
    const login = verify(req);
    if (!login) return reject(401, 'Unauthorized');
    wss.handleUpgrade(req, socket, head, ws => onConnection(ws, url, login));
  });

  function onConnection(ws: WebSocket, url: URL, login: Login) {
    const s = sessions.get(url.searchParams.get('session') ?? '');
    if (!s) return ws.close(CLOSE.NO_SESSION, 'no such session');
    // 로그아웃·만료·유휴 판단은 LoginManager가 소유. 폐기되면 이 소켓을 4401로 닫음
    logins.attach(login, ws);
    s.clients++;
    const send = (m: object) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));

    const cols = Number(url.searchParams.get('cols')), rows = Number(url.searchParams.get('rows'));
    if (s.exitCode === null && cols > 0 && rows > 0) s.pty.resize(cols, rows);

    // 리플레이와 구독을 같은 동기 구간에서 수행 → 사이에 PTY 이벤트가 끼어들 수 없어 누락/중복 없음
    const r = s.buf.readFrom(Number(url.searchParams.get('resume') ?? 0));
    send({ t: 'out', s: r.start, d: r.data, ...(r.gap && { reset: true }) });
    const onData = (d: string, start: number) => {
      if (ws.bufferedAmount > MAX_BUFFERED) return ws.terminate(); // 클라는 resume으로 복구
      send({ t: 'out', s: start, d });
    };
    const onExit = (code: number) => send({ t: 'exit', code });
    const onClosed = () => ws.close(CLOSE.NO_SESSION, 'session closed');
    s.events.on('data', onData);
    s.events.on('exit', onExit);
    s.events.on('closed', onClosed);
    if (s.exitCode !== null) onExit(s.exitCode);

    // 서버측 Half-open 감지: 프로토콜 ping, 다음 주기까지 pong 없으면 terminate
    let alive = true;
    ws.on('pong', () => { alive = true; });
    const hb = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
    }, HEARTBEAT_MS);

    ws.on('message', raw => {
      let m: any;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.t === 'ping') return send({ t: 'pong', id: m.id });
      if (s.exitCode !== null) return;
      if (m.t === 'in' && typeof m.d === 'string') s.pty.write(m.d);
      // 여러 클라이언트가 같은 세션을 보면 마지막 resize가 이김
      else if (m.t === 'resize' && m.c > 0 && m.r > 0 && m.c < 1000 && m.r < 1000) s.pty.resize(m.c | 0, m.r | 0);
    });

    ws.on('close', () => {
      clearInterval(hb);
      logins.detach(login, ws);
      s.clients--;
      s.events.off('data', onData);
      s.events.off('exit', onExit);
      s.events.off('closed', onClosed);
    });
  }

  return wss;
}
