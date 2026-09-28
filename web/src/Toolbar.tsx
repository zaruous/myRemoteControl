import type { TabApi } from './TerminalTab';

// onPointerDown + preventDefault: 버튼을 눌러도 xterm 입력창 포커스가 유지돼 가상 키보드가 닫히지 않음
export function Toolbar({ api, ctrl, setCtrl }: { api?: TabApi; ctrl: boolean; setCtrl(v: boolean): void }) {
  const press = (fn: () => void) => (e: React.PointerEvent) => { e.preventDefault(); fn(); };
  const raw = (d: string) => press(() => api?.sendRaw(d));
  return (
    <div className="toolbar">
      <button onPointerDown={raw('\x1b')}>Esc</button>
      <button onPointerDown={raw('\t')}>Tab</button>
      <button className={ctrl ? 'on' : ''} onPointerDown={press(() => { setCtrl(!ctrl); api?.focus(); })}>Ctrl</button>
      <button onPointerDown={press(() => api?.arrow('D'))}>←</button>
      <button onPointerDown={press(() => api?.arrow('B'))}>↓</button>
      <button onPointerDown={press(() => api?.arrow('A'))}>↑</button>
      <button onPointerDown={press(() => api?.arrow('C'))}>→</button>
      <button onPointerDown={raw('|')}>|</button>
      <button onPointerDown={raw('~')}>~</button>
      <button onPointerDown={raw('/')}>/</button>
    </div>
  );
}
