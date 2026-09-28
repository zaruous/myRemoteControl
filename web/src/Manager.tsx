import { useEffect, useState } from 'react';

interface LoginRow { id: string; ua: string; createdAt: number; lastSeen: number; sockets: number; current: boolean }
interface SessionRow { id: string; title: string; pid: number; process: string | null; clients: number; exitCode: number | null }

const time = (t: number) => new Date(t).toLocaleString();

// 로그인 기기와 터미널 세션(PID) 관리 패널
export function Manager({ onClose, onLoggedOut, onKill }: { onClose(): void; onLoggedOut(): void; onKill(id: string): Promise<void> }) {
  const [logins, setLogins] = useState<LoginRow[]>([]);
  const [sessions, setSessions] = useState<SessionRow[]>([]);

  const refresh = async () => {
    const [l, s] = await Promise.all([fetch('/api/logins'), fetch('/api/sessions')]);
    if (l.status === 401 || s.status === 401) return onLoggedOut();
    setLogins(await l.json());
    setSessions(await s.json());
  };
  useEffect(() => { refresh(); }, []);

  const revoke = async (row: LoginRow) => {
    await fetch(`/api/logins/${row.id}`, { method: 'DELETE' });
    row.current ? onLoggedOut() : refresh();
  };
  const revokeAll = async () => {
    if (!confirm('모든 기기에서 로그아웃할까요? 터미널은 계속 실행됩니다.')) return;
    await fetch('/api/logins', { method: 'DELETE' });
    onLoggedOut();
  };

  return (
    <div className="mgr">
      <header><b>관리</b><button onClick={refresh}>새로고침</button><button onClick={onClose} aria-label="닫기">×</button></header>
      <h2>로그인 기기</h2>
      <ul>
        {logins.map(l => (
          <li key={l.id}>
            <div><b>{l.current ? '이 기기' : l.id}</b> · 접속 {l.sockets} · 마지막 활동 {time(l.lastSeen)}<br /><small>{l.ua}</small></div>
            <button onClick={() => revoke(l)}>로그아웃</button>
          </li>
        ))}
      </ul>
      <button className="danger" onClick={revokeAll}>모든 기기 로그아웃</button>
      <h2>터미널 세션</h2>
      <ul>
        {sessions.map(s => (
          <li key={s.id}>
            <div><b>{s.title}</b> · PID {s.pid} · {s.exitCode === null ? (s.process ?? '?') : `종료됨 (exit ${s.exitCode})`} · 접속 {s.clients}<br /><small>{s.id}</small></div>
            <button onClick={async () => { await onKill(s.id); refresh(); }}>종료</button>
          </li>
        ))}
      </ul>
    </div>
  );
}
