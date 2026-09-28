// 최초 1회: 비밀번호 설정 + TOTP 시크릿 생성 + QR 출력 + 코드 1회 검증 후 저장
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { authenticator } from 'otplib';
import qrcode from 'qrcode-terminal';
import { AUTH_FILE, hashPassword } from './auth.js';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string, hidden = false) => new Promise<string>(resolve => {
  const r = rl as any;
  const orig = r._writeToOutput;
  if (hidden) r._writeToOutput = (s: string) => { if (s.includes(q)) orig.call(r, s); };
  rl.question(q, a => { r._writeToOutput = orig; if (hidden) process.stdout.write('\n'); resolve(a); });
});

if (fs.existsSync(AUTH_FILE) && (await ask(`${AUTH_FILE} 가 이미 있습니다. 덮어쓸까요? (yes/no) `)) !== 'yes') process.exit(0);

const pw = await ask('새 비밀번호(12자 이상): ', true);
if (pw.length < 12 || pw !== await ask('비밀번호 확인: ', true)) { console.error('비밀번호가 짧거나 일치하지 않습니다.'); process.exit(1); }

const secret = authenticator.generateSecret(20); // 20바이트=160bit (기본값 10바이트는 RFC 4226 권장치 미달)
const uri = authenticator.keyuri(process.env.USER || 'me', 'webterm', secret);
console.log('\nGoogle Authenticator로 아래 QR을 스캔하세요:\n');
qrcode.generate(uri, { small: true });
console.log(`\nQR이 깨지면 수동 입력 키: ${secret}\n`);

// 스캔이 제대로 됐는지 확인한 뒤에만 저장 (잘못 등록된 채로 잠기는 사고 방지)
const code = await ask('앱에 표시된 6자리 코드: ');
if (!authenticator.check(code.trim(), secret)) { console.error('코드 불일치. 저장하지 않았습니다.'); process.exit(1); }

fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true, mode: 0o700 });
fs.writeFileSync(AUTH_FILE, JSON.stringify({ passwordHash: hashPassword(pw), totpSecret: secret }), { mode: 0o600 });
console.log(`저장 완료: ${AUTH_FILE} (권한 600)`);
rl.close();
