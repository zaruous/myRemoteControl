import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { ResumableSocket, type ConnState } from './conn';

export interface TabApi {
  sendRaw(d: string): void;
  arrow(dir: 'A' | 'B' | 'C' | 'D'): void;
  focus(): void;
  resume(): void;
}

interface Props {
  id: string;
  active: boolean;
  ctrlArmed: React.MutableRefObject<boolean>;
  onCtrlUsed(): void;
  register(id: string, api: TabApi | null): void;
  onAuthExpired(): void;
  onGone(id: string): void;
}

export function TerminalTab({ id, active, ctrlArmed, onCtrlUsed, register, onAuthExpired, onGone }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon>();
  const [state, setState] = useState<ConnState>('connecting');
  const [exit, setExit] = useState<number | null>(null);

  useEffect(() => {
    const term = new Terminal({ scrollback: 5000, fontSize: 14, cursorBlink: true, theme: { background: '#1b1f24' } });
    const fit = new FitAddon();
    fitRef.current = fit;
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(el.current!);
    if (el.current!.offsetWidth > 0) fit.fit();

    const sock = new ResumableSocket(id, {
      write: d => term.write(d),
      reset: () => term.reset(),
      size: () => ({ cols: term.cols, rows: term.rows }),
      onState: setState,
      onExit: setExit,
      onAuthExpired,
      onGone: () => onGone(id),
    });

    const sendRaw = (d: string) => { sock.send({ t: 'in', d }); };
    term.onData(d => {
      // 툴바의 Ctrl(1회성 토글): 다음 한 글자를 제어문자로 변환. a→0x01, [→ESC 등
      if (ctrlArmed.current && d.length === 1) {
        const c = d.toUpperCase().charCodeAt(0);
        if (c >= 64 && c <= 95) d = String.fromCharCode(c & 0x1f);
        onCtrlUsed();
      }
      sendRaw(d);
    });
    term.onResize(({ cols, rows }) => sock.send({ t: 'resize', c: cols, r: rows }));

    const ro = new ResizeObserver(() => { if (el.current!.offsetWidth > 0) fit.fit(); });
    ro.observe(el.current!);

    register(id, {
      sendRaw,
      // htop/vim 등은 application cursor 모드(DECCKM)에서 ESC O A 형식을 기대
      arrow: dir => sendRaw((term.modes.applicationCursorKeysMode ? '\x1bO' : '\x1b[') + dir),
      focus: () => term.focus(),
      resume: () => sock.kick(),
    });

    return () => { register(id, null); ro.disconnect(); sock.dispose(); term.dispose(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // 숨겨졌던 탭은 크기 0이라 fit 불가 → 보일 때 다시 fit
  useEffect(() => { if (active) requestAnimationFrame(() => fitRef.current?.fit()); }, [active]);

  return (
    <div className="term-wrap" style={{ display: active ? 'block' : 'none' }}>
      <div ref={el} className="term" />
      {state !== 'open' && exit === null && <div className="banner">{state === 'connecting' ? '연결 중…' : '연결 끊김 · 재연결 대기 중 (입력은 전송되지 않음)'}</div>}
      {exit !== null && <div className="banner">프로세스 종료됨 (exit {exit}). 탭을 닫으세요.</div>}
    </div>
  );
}
