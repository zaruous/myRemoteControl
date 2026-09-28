import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Request, Response, NextFunction } from 'express';
import { authenticator } from 'otplib';

export const AUTH_FILE = process.env.WEBTERM_AUTH_FILE || path.join(os.homedir(), '.webterm', 'auth.json');
const TOKEN_TTL_MS = Number(process.env.WEBTERM_TOKEN_TTL_MIN || 480) * 60_000; // 기본 8시간
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60_000;

interface AuthFile { passwordHash: string; totpSecret: string }

export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  return `${salt.toString('hex')}:${scryptSync(pw, salt, 64).toString('hex')}`;
}

function checkPassword(pw: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(':');
  const actual = scryptSync(pw, Buffer.from(saltHex, 'hex'), 64);
  return timingSafeEqual(actual, Buffer.from(hashHex, 'hex'));
}

function loadAuth(): AuthFile {
  if (!fs.existsSync(AUTH_FILE)) throw new Error(`${AUTH_FILE} 없음. 먼저 'npm run setup' 실행`);
  return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
}

// 단일 사용자 전제. 데몬 재시작 시 토큰 전부 무효화(어차피 PTY도 전부 사라짐).
const tokens = new Map<string, number>(); // token -> expiresAt
let fails = 0, lockedUntil = 0, lastTotpStep = -1;

authenticator.options = { window: 1 }; // ±30초 시계 오차 허용

export function login(req: Request, res: Response) {
  const auth = loadAuth();
  if (Date.now() < lockedUntil) return res.status(429).json({ error: 'locked' });
  const { password, otp } = req.body ?? {};
  if (typeof password !== 'string' || typeof otp !== 'string') return res.status(400).json({ error: 'bad request' });

  const pwOk = checkPassword(password, auth.passwordHash);
  const delta = authenticator.checkDelta(otp, auth.totpSecret); // null이면 불일치
  const step = delta === null ? -1 : Math.floor(Date.now() / 30_000) + delta;
  // 같은 OTP 재사용(리플레이) 차단: 이미 사용한 time-step 이하 거부
  if (!pwOk || delta === null || step <= lastTotpStep) {
    // ponytail: 전역 잠금. 공격자가 소유자를 15분 잠글 수 있음(DoS) — 단일 사용자 PoC 한계
    if (++fails >= MAX_FAILS) { lockedUntil = Date.now() + LOCK_MS; fails = 0; }
    return res.status(401).json({ error: 'invalid credentials' });
  }
  fails = 0;
  lastTotpStep = step;
  const token = randomBytes(32).toString('base64url');
  const exp = Date.now() + TOKEN_TTL_MS;
  tokens.set(token, exp);
  res.cookie('wt', token, { httpOnly: true, secure: req.secure || req.headers['x-forwarded-proto'] === 'https', sameSite: 'strict', maxAge: TOKEN_TTL_MS, path: '/' });
  res.json({ exp });
}

export function logout(req: Request, res: Response) {
  const t = readCookie(req.headers.cookie);
  if (t) tokens.delete(t);
  res.clearCookie('wt', { path: '/' });
  res.json({ ok: true });
}

function readCookie(header?: string): string | undefined {
  return header?.split(';').map(s => s.trim()).find(s => s.startsWith('wt='))?.slice(3);
}

/** 유효하면 만료시각(ms), 아니면 null. HTTP·WS 공용 */
export function verifyRequest(req: IncomingMessage): number | null {
  const t = readCookie(req.headers.cookie);
  const exp = t ? tokens.get(t) : undefined;
  if (!t || !exp) return null;
  if (exp < Date.now()) { tokens.delete(t); return null; }
  return exp;
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (verifyRequest(req) === null) return res.status(401).json({ error: 'unauthorized' });
  next();
}
