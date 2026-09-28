# webterm — 재접속 복구형 웹/모바일 터미널 (PoC)

## 1. 아키텍처

```
 [폰 브라우저/PWA]   [데스크톱 브라우저]
        │  HTTPS / WSS (쿠키 인증)
        ▼
 ┌─────────────────────────────┐    ┌──────────────────────────┐
 │ tailscale serve (*.ts.net)  │ or │ cloudflared + CF Access  │   ← TLS 종단. 외부 포트포워딩 없음
 └──────────────┬──────────────┘    └────────────┬─────────────┘
                └──────────► 127.0.0.1:7681 ◄─────┘
 ┌──────────────────────────────────────────────────────────────┐
 │ webterm 데몬 (Node/TS)                                        │
 │  Express  /api/login  → 비밀번호(scrypt)+TOTP → HttpOnly 쿠키   │
 │           /api/sessions  GET/POST/DELETE (requireAuth)        │
 │  ws       /ws?session&resume  ← Origin 화이트리스트 + 쿠키 검증   │
 │  SessionManager ── Session{ pty(node-pty), RingBuffer(2MB) }  │
 │                     PTY 출력은 클라 유무와 무관하게 항상 버퍼 적재   │
 └──────────────────────────────────────────────────────────────┘
```

**seq = 세션 시작 이후 누적 문자 오프셋.** 청크 번호 대신 오프셋을 쓰면 "여기까지 받았다"가 정확하고, 청크 중간부터 이어 보낼 수 있다. 서버는 항상 버퍼를 유지하므로 별도 ACK 메시지가 필요 없다(재접속 시 resume 오프셋이 곧 ACK).

## 2. 세션 복구 시퀀스

```
Client                                 Server(ws.ts)                    PTY/RingBuffer
  │ WS /ws?session=S&resume=0            │                                  │
  │─────────────────────────────────────►│ Origin·쿠키 검증                   │
  │                                      │ readFrom(0) + 구독 (동일 동기 구간)  │
  │◄──── {out, s:0, d:"...1200자"} ──────│                                  │
  │ offset=1200                          │◄──────── data(1200..1500) ───────│
  │◄──── {out, s:1200, d:300자} ─────────│                                  │
  │ offset=1500                          │                                  │
  ╳ ─── LTE→Wi-Fi 전환 / 엘리베이터 ───── ╳  (서버: pong 없음→terminate)     │
  │ (클라: 20초 무수신→소켓 폐기)          │◄──────── data(1500..4000) ───────│ 버퍼에 계속 적재
  │ backoff: rand()*min(15s, 0.5s·2^n)   │                                  │
  │ WS /ws?session=S&resume=1500          │                                  │
  │─────────────────────────────────────►│ readFrom(1500)                   │
  │◄──── {out, s:1500, d:2500자} ────────│  → 끊긴 구간 정확히 리플레이        │
  │ s == offset 확인 → write              │                                  │
  │                                      │                                  │
  │ (끊긴 동안 출력 > 버퍼 2MB 인 경우)     │ readFrom → gap                   │
  │◄──── {out, s:tail, d, reset:true} ───│  클라: term.reset() 후 남은 것만    │
```

## 3. 실행 절차

전제: Linux/macOS, Node 20+, 빌드 도구(node-pty 네이티브 빌드용: `python3 make g++`, macOS는 Xcode CLT).

```bash
# 1) 서버
cd server && npm install
npm run setup          # 비밀번호 입력 → 터미널에 QR 출력 → Google Authenticator로 스캔
                       # → 앱의 6자리 코드를 입력해야 저장됨 (~/.webterm/auth.json, 권한 600)
npm test               # 링버퍼 + 강제절단/resume + Origin 차단 테스트

# 2) 프론트 빌드 (서버가 web/dist를 정적 서빙)
cd ../web && npm install && npm run build

# 3) 외부 노출 — 둘 중 하나
## A. Tailscale (권장)
tailscale serve --bg 7681      # https://<기기명>.<tailnet>.ts.net → 127.0.0.1:7681
WEBTERM_ORIGINS=https://<기기명>.<tailnet>.ts.net npm --prefix ../server start
## B. Cloudflare Tunnel — 반드시 Cloudflare Access 정책을 앞에 둘 것
cloudflared tunnel run <tunnel>   # ingress: https://term.example.com → http://localhost:7681
WEBTERM_ORIGINS=https://term.example.com npm --prefix ../server start
```

개발 모드: `server`에서 `npm start`, `web`에서 `npm run dev` → http://localhost:5173 (Vite가 /api, /ws 프록시).

환경변수: `PORT`(7681) `HOST`(127.0.0.1) `WEBTERM_ORIGINS` `WEBTERM_TOKEN_TTL_MIN`(480) `WEBTERM_BUFFER_CHARS`(2000000) `WEBTERM_AUTH_FILE`.

## 4. 검증된 것 / 안 된 것

`npm test`로 확인: 출력 도중 소켓 강제 절단 → 300ms 동안 PTY 계속 출력 → resume 재접속 시 3,000줄이 누락·중복 없이 연속, 버퍼 초과 시 `reset` 플래그, 잘못된 Origin 403. 수동 확인: 틀린 비밀번호 401, 정상 로그인 200, **같은 OTP 재사용 401**.

실기기(iOS Safari/Android Chrome)에서의 툴바·가상 키보드·백그라운드 복귀 동작은 검증하지 않았다.
