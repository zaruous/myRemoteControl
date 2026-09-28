import { useCallback, useEffect, useRef, useState } from 'react';
import { TerminalTab, type TabApi } from './TerminalTab';
import { Toolbar } from './Toolbar';
import { Manager } from './Manager';

interface Tab { id: string; title: string }
const json = { 'content-type': 'application/json' };

export function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<string>();
  const [ctrl, setCtrlState] = useState(false);
  const ctrlRef = useRef(false);
  const apis = useRef(new Map<string, TabApi>());
  const [, bump] = useState(0);
  const [mgr, setMgr] = useState(false);

  const setCtrl = (v: boolean) => { ctrlRef.current = v; setCtrlState(v); };
  const register = useCallback((id: string, api: TabApi | null) => {
    api ? apis.current.set(id, api) : apis.current.delete(id);
    bump(n => n + 1);
  }, []);

  const load = async () => {
    const r = await fetch('/api/sessions');
    if (r.status === 401) return setAuthed(false);
    const list: Tab[] = await r.json();
    setTabs(list);
    setActive(a => a && list.some(t => t.id === a) ? a : list[0]?.id);
    setAuthed(true);
  };
  useEffect(() => { load(); }, []);

  const newTab = async () => {
    const r = await fetch('/api/sessions', { method: 'POST', headers: json, body: '{}' });
    if (r.status === 401) return setAuthed(false);
    const t: Tab = await r.json();
    setTabs(ts => [...ts, t]);
    setActive(t.id);
  };
  const removeTab = (id: string) => {
    setTabs(ts => {
      const rest = ts.filter(t => t.id !== id);
      setActive(a => (a === id ? rest[0]?.id : a));
      return rest;
    });
  };
  const closeTab = async (id: string) => {
    if (!confirm('이 터미널을 종료할까요? 실행 중인 프로세스도 함께 종료됩니다.')) return;
    await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
    removeTab(id);
  };
  const onAuthExpired = useCallback(() => setAuthed(false), []);
  // 재로그인: 탭(xterm·오프셋)을 유지한 채 멈춰 있던 소켓만 이어받게 함 → 전체 리플레이 없이 끊긴 구간만 수신
  const onLogin = async () => { await load(); apis.current.forEach(a => a.resume()); };

  if (authed === null) return null;
  if (!authed && tabs.length === 0) return <Login onDone={onLogin} />;

  return (
    <div className="app">
      <nav className="tabs">
        {tabs.map(t => (
          <div key={t.id} className={t.id === active ? 'tab on' : 'tab'} onClick={() => setActive(t.id)}>
            {t.title}
            <button aria-label={`${t.title} 닫기`} onClick={e => { e.stopPropagation(); closeTab(t.id); }}>×</button>
          </div>
        ))}
        <button className="new" onClick={newTab} aria-label="새 터미널">＋</button>
        <button className="new mgr-btn" onClick={() => setMgr(m => !m)} aria-label="관리">⋯</button>
      </nav>
      {mgr && <Manager onClose={() => setMgr(false)} onKill={closeTab}
        onLoggedOut={() => { setMgr(false); setTabs([]); setAuthed(false); }} />}
      {/* 명시적 로그아웃은 만료와 달리 터미널을 언마운트 → 이전 출력이 DOM에 남지 않음 */}
      <main className="terms">
        {tabs.length === 0 && <button className="empty" onClick={newTab}>새 터미널 열기</button>}
        {/* 모든 탭을 마운트 유지 → 탭 전환 시 xterm 상태·소켓이 살아 있음 */}
        {tabs.map(t => (
          <TerminalTab key={t.id} id={t.id} active={t.id === active} ctrlArmed={ctrlRef}
            onCtrlUsed={() => setCtrl(false)} register={register}
            onAuthExpired={onAuthExpired} onGone={removeTab} />
        ))}
      </main>
      <Toolbar api={active ? apis.current.get(active) : undefined} ctrl={ctrl} setCtrl={setCtrl} />
      {/* 인증 만료 시 터미널을 언마운트하지 않고 위에 덮음 */}
      {!authed && <div className="overlay"><Login onDone={onLogin} /></div>}
    </div>
  );
}

function Login({ onDone }: { onDone(): void }) {
  const [password, setPassword] = useState('');
  const [otp, setOtp] = useState('');
  const [err, setErr] = useState('');
  const submit = async () => {
    const r = await fetch('/api/login', { method: 'POST', headers: json, body: JSON.stringify({ password, otp }) });
    if (r.ok) return onDone();
    setOtp('');
    setErr(r.status === 429 ? '로그인 실패가 반복되어 15분간 잠겼습니다.' : '비밀번호 또는 인증 코드가 올바르지 않습니다. 같은 코드는 한 번만 쓸 수 있습니다.');
  };
  return (
    <div className="login">
      <h1>webterm</h1>
      <input type="password" placeholder="비밀번호" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} />
      <input inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="인증 앱 6자리 코드" value={otp}
        onChange={e => setOtp(e.target.value.replace(/\D/g, ''))} onKeyDown={e => e.key === 'Enter' && submit()} />
      <button onClick={submit} disabled={!password || otp.length !== 6}>로그인</button>
      {err && <p className="err">{err}</p>}
    </div>
  );
}
