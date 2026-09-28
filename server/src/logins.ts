// 로그인(기기) 관리. 토큰마다 발급·마지막 활동 시각과 연결된 WebSocket을 추적해
// 기기별/전체 로그아웃, 유휴 만료, 인증 파일 변경 시 무효화를 한곳에서 처리한다.
import { randomBytes } from 'node:crypto';

export interface Sock { close(code: number, reason?: string): void }
export interface Login {
  id: string;        // 목록·폐기용 공개 식별자 (토큰과 별개)
  token: string;
  ua: string;
  createdAt: number;
  lastSeen: number;  // 마지막 HTTP 요청 또는 WS 해제 시각
  exp: number;       // 절대 만료
  version: string;   // 발급 당시 인증 파일 버전
  sockets: Set<Sock>;
}

const CLOSE_AUTH = 4401;

export class LoginManager {
  private logins = new Map<string, Login>(); // token -> Login
  private readonly now: () => number;

  constructor(private readonly o: { ttlMs: number; idleMs: number; version: () => string; now?: () => number }) {
    this.now = o.now ?? Date.now;
  }

  issue(ua: string): Login {
    const t = this.now();
    const l: Login = {
      id: randomBytes(6).toString('hex'), token: randomBytes(32).toString('base64url'), ua: ua.slice(0, 200),
      createdAt: t, lastSeen: t, exp: t + this.o.ttlMs, version: this.o.version(), sockets: new Set(),
    };
    this.logins.set(l.token, l);
    return l;
  }

  /** 유효하면 Login(활동 시각 갱신), 아니면 null. 무효 토큰은 즉시 폐기 */
  check(token?: string): Login | null {
    const l = token ? this.logins.get(token) : undefined;
    if (!l) return null;
    if (!this.valid(l, this.o.version())) { this.drop(l); return null; }
    l.lastSeen = this.now();
    return l;
  }

  attach(l: Login, s: Sock) { l.sockets.add(s); }
  detach(l: Login, s: Sock) { l.sockets.delete(s); l.lastSeen = this.now(); }

  revoke(id: string): boolean {
    const l = [...this.logins.values()].find(x => x.id === id);
    if (!l) return false;
    this.drop(l);
    return true;
  }

  revokeAll() { for (const l of [...this.logins.values()]) this.drop(l); }

  list() {
    this.sweep();
    return [...this.logins.values()].map(({ id, ua, createdAt, lastSeen, exp, sockets }) =>
      ({ id, ua, createdAt, lastSeen, exp, sockets: sockets.size }));
  }

  /** 주기적으로 호출: 만료·유휴·인증 파일 변경된 로그인을 폐기하고 열린 WS도 닫음 */
  sweep() {
    const v = this.o.version();
    for (const l of [...this.logins.values()]) if (!this.valid(l, v)) this.drop(l);
  }

  private valid(l: Login, version: string) {
    const t = this.now();
    return t < l.exp && l.version === version && (l.sockets.size > 0 || t - l.lastSeen <= this.o.idleMs);
  }

  private drop(l: Login) {
    this.logins.delete(l.token);
    for (const s of l.sockets) s.close(CLOSE_AUTH, 'logged out');
    l.sockets.clear();
  }
}
