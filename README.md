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

---

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

---

## 3. 프로그램 설치 및 실행 방법 가이드

### 3.1. 사전 준비 (Prerequisites)
- **OS**: Linux / macOS
- **Node.js**: 20 이상 (권장: Node 20 LTS 또는 22 LTS, `nvm` 사용 권장)
- **빌드 도구** (`node-pty` C++ 네이티브 빌드용):
  - Ubuntu/Debian: `sudo apt install python3 make g++`
  - macOS: `xcode-select --install`

---

### 3.2. 의존성 설치 및 프론트엔드 빌드

```bash
# 1) 저장소 복제 (필요 시)
git clone https://github.com/zaruous/myRemoteControl.git
cd myRemoteControl

# 2) 서버 의존성 설치 및 단위 테스트
cd server
npm install
npm test

# 3) 프론트엔드 의존성 설치 및 정적 파일 빌드
cd ../web
npm install
npm run build
```

---

### 3.3. 최초 1회 인증 설정 (비밀번호 + Google OTP)

서버 디렉토리(`server`)에서 초기 보안 설정을 실행합니다:

```bash
cd ../server
npm run setup
```

1. **비밀번호 입력**: 12자 이상의 안전한 비밀번호 입력 (확인 포함 2회)
2. **OTP 등록**: 터미널에 출력되는 QR 코드를 스마트폰의 **Google Authenticator** 또는 **Authy** 앱으로 스캔
3. **코드 검증**: 앱에 표시된 6자리 번호를 입력하여 확인 완료
4. 완료 시 `~/.webterm/auth.json` (권한 600) 파일에 저장됩니다.

---

### 3.4. 서버 실행 방법

환경과 접속 방식에 따라 아래 방법 중 하나를 선택하여 실행합니다.

#### 방법 A. 로컬 네트워크(LAN)에서 접속하는 경우 (기본)
같은 와이파이나 내부 공유기망(`192.168.x.x`)에서 바로 접속할 때 사용합니다:

```bash
cd server
HOST=0.0.0.0 WEBTERM_ORIGINS=* npm start
```
- 브라우저 접속: `http://<서버IP>:7681` (예: `http://192.168.45.7:7681`)
- *참고: 동일 호스트 접속은 기본 허용되므로 `HOST=0.0.0.0 npm start`로도 실행 가능합니다.*

#### 방법 B. Tailscale로 외부에서 보안 접속하는 경우 (권장 ⭐)
포트포워딩 없이 외부(스마트폰/외부 PC)에서 안전하게 접속할 때 권장합니다:

```bash
# 1) Tailscale 서브 도메인 연결 (HTTPS 자동 발급)
tailscale serve --bg 7681

# 2) 서버 실행 (Tailscale 도메인 또는 * 허용)
WEBTERM_ORIGINS=* npm start
```
- 브라우저 접속: `https://<기기명>.<tailnet>.ts.net` 또는 부여받은 Tailscale 고정 IP `http://100.x.y.z:7681`

#### 방법 C. ngrok으로 외부 임시 접속하는 경우
빠른 외부 테스트용 임시 터널링:

```bash
# 터미널 1: ngrok 백그라운드 실행
nohup ngrok http 7681 > ~/ngrok.log 2>&1 &

# 터미널 2: 서버 실행
HOST=0.0.0.0 WEBTERM_ORIGINS=* npm start
```
- 브라우저 접속: ngrok이 발급한 `https://xxxx.ngrok-free.app` 접속

#### 방법 D. 개발 모드 (HMR 지원)
코드 수정 시 즉시 반영되는 개발 환경:

```bash
# 터미널 1 (서버)
cd server && npm start

# 터미널 2 (Vite 프론트엔드 개발 서버)
cd web && npm run dev
```
- 브라우저 접속: `http://localhost:5173` (Vite가 `/api`, `/ws`를 자동으로 백엔드로 프록시)

---

### 3.5. 백그라운드 상시 실행 (systemd 서비스 등록)

서버 재부팅 시에도 터미널 데몬이 자동으로 실행되도록 설정하려면:

1. 서비스 유닛 파일 생성 (`/etc/systemd/system/webterm.service`):
```ini
[Unit]
Description=Webterm Remote Terminal Service
After=network.target

[Service]
Type=simple
User=kyj
WorkingDirectory=/home/kyj/git/myRemoteControl/server
Environment="HOST=0.0.0.0"
Environment="PORT=7681"
Environment="WEBTERM_ORIGINS=*"
ExecStart=/home/kyj/.nvm/versions/node/v22.23.2/bin/node /home/kyj/git/myRemoteControl/server/node_modules/.bin/tsx src/index.ts
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

2. 서비스 등록 및 시작:
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now webterm
sudo systemctl status webterm
```

---

### 3.6. 환경 변수 요약

| 환경 변수 | 기본값 | 설명 |
| :--- | :--- | :--- |
| `PORT` | `7681` | 서버 수신 포트 |
| `HOST` | `127.0.0.1` | 바인딩 호스트 (`0.0.0.0` 설정 시 외부/LAN 접속 허용) |
| `WEBTERM_ORIGINS` | `http://localhost:5173` | 허용할 Origin 목록(쉼표 구분) 또는 `*` (모든 Origin 허용) |
| `WEBTERM_TOKEN_TTL_MIN`| `480` (8시간) | 로그인 세션 쿠키 유효 기간 (분) |
| `WEBTERM_BUFFER_CHARS` | `2000000` (~2MB) | PTY 세션당 링버퍼 크기 (문자 수) |
| `WEBTERM_AUTH_FILE` | `~/.webterm/auth.json` | 인증 정보 파일 저장 경로 |

---

## 4. 트러블슈팅 (자주 묻는 질문)

- **"연결 끊김 · 재연결 대기 중" 배너가 계속 뜨는 경우**:
  - 웹소켓 Origin 차단(403)일 가능성이 높습니다. 서버 실행 시 `WEBTERM_ORIGINS=*` 옵션을 주었는지 확인하세요.
- **로그인 실패 또는 OTP 재사용 에러 (401)**:
  - Google Authenticator의 6자리 번호는 30초마다 갱신되며, 일회용이므로 같은 코드로 연속 로그인은 불가능합니다. 다음 번호로 갱신된 후 다시 시도하세요.
  - 인증 정보를 재설정하려면 `npm run setup`을 다시 실행하여 덮어쓰기(`yes`) 하시면 됩니다.
- **모바일 브라우저에서 가상 키보드가 가려지는 경우**:
  - 하단 모바일 툴바의 단축키 버튼(Esc, Tab, Ctrl, 방향키)을 활용하여 터미널 제어가 가능합니다.

---

## 5. 검증된 것 / 안 된 것

- **`npm test`로 확인**: 출력 도중 소켓 강제 절단 → 300ms 동안 PTY 계속 출력 → resume 재접속 시 3,000줄이 누락·중복 없이 연속, 버퍼 초과 시 `reset` 플래그, 잘못된 Origin 403, 동일 Host 및 와일드카드 Origin 허용.
- **수동 확인**: 틀린 비밀번호 401, 정상 로그인 200, 같은 OTP 재사용 401.
- 실기기(iOS Safari/Android Chrome)에서의 툴바·가상 키보드·백그라운드 복귀 동작은 검증하지 않았다.
