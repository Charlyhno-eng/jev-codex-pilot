import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api.js";
import { TerminalScreen } from "../lib/terminal-screen.js";

type TerminalInfo = { id: string; exitCode?: number };
type Output = { data: string; cursor: number; truncated: boolean; exitCode?: number };

/** Connects an explicitly opened project shell to keyboard input and live output in the browser. */
export function ProjectTerminal({ projectId, active }: { projectId: string; active: boolean }) {
  const base = `/projects/${projectId}/terminal`;
  const [sessions, setSessions] = useState<TerminalInfo[]>([]);
  const [selected, setSelected] = useState("");
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [exited, setExited] = useState<number>();
  const output = useRef<HTMLPreElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const inputQueue = useRef(Promise.resolve());
  useEffect(() => {
    let cancelled = false;
    void api<TerminalInfo[]>(base).then(list => { if (!cancelled) { setSessions(list); setSelected(list.find(s => s.exitCode === undefined)?.id ?? list[0]?.id ?? ""); } }).catch(reason => { if (!cancelled) setError(String(reason)); });
    return () => { cancelled = true; };
  }, [base]);
  useEffect(() => {
    if (!selected) { setText(""); return; }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let screen = new TerminalScreen();
    let cursor = 0;
    setText(""); setExited(undefined); setError("");
    const poll = async () => {
      try {
        const result = await api<Output>(`${base}/${selected}?cursor=${cursor}`);
        if (cancelled) return;
        if (result.truncated) screen = new TerminalScreen();
        screen.write(result.data); cursor = result.cursor;
        setText(screen.text()); setExited(result.exitCode);
        if (result.exitCode !== undefined) return;
      } catch (reason) { if (!cancelled) setError(String(reason)); }
      if (!cancelled) timer = setTimeout(() => void poll(), 150);
    };
    void api(`${base}/${selected}`, { method: "POST", body: JSON.stringify({ cols: screen.cols, rows: screen.rows }) }).catch(() => {});
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [base, selected]);
  useEffect(() => { if (active && selected) input.current?.focus({ preventScroll: true }); }, [active, selected]);
  useEffect(() => { const element = output.current; if (element) element.scrollTop = element.scrollHeight; }, [text]);
  const send = (data: string) => {
    if (!selected || exited !== undefined) return;
    const path = `${base}/${selected}`;
    inputQueue.current = inputQueue.current.then(() => api(path, { method: "POST", body: JSON.stringify({ data }) })).then(() => {}).catch(reason => setError(String(reason)));
  };
  const start = async () => {
    setBusy(true); setError("");
    try { const session = await api<TerminalInfo>(base, { method: "POST" }); setSessions(list => [...list, session]); setSelected(session.id); }
    catch (reason) { setError(String(reason)); } finally { setBusy(false); }
  };
  const close = async () => {
    setBusy(true);
    try { await api(`${base}/${selected}`, { method: "DELETE" }); const next = sessions.filter(s => s.id !== selected); setSessions(next); setSelected(next[0]?.id ?? ""); }
    catch (reason) { setError(String(reason)); } finally { setBusy(false); }
  };
  const urls = [...new Set(text.match(/http:\/\/(?:localhost|127\.0\.0\.1):\d{2,5}(?:\/[^\s<>\x1b]*)?/g) ?? [])];
  return <section className="ide-terminal" aria-label="Project terminal">
    <header><div className="terminal-heading"><span className="terminal-icon" aria-hidden="true">›_</span><div><b>Terminal</b><small>Project shell</small></div><span className={`terminal-status ${!selected ? "idle" : exited !== undefined ? "exited" : "live"}`} role="status"><i/>{!selected ? "Not started" : exited !== undefined ? "Exited" : "Session open"}</span></div><div className="ide-actions"><select aria-label="Select terminal" value={selected} onChange={event => setSelected(event.target.value)} disabled={!sessions.length}>{!sessions.length && <option value="">No terminal</option>}{sessions.map((session, index) => <option key={session.id} value={session.id}>Terminal {index + 1}</option>)}</select><button className="terminal-new" onClick={() => void start()} disabled={busy || sessions.length >= 4}><span aria-hidden="true">＋</span> New terminal</button>{selected && <><button onClick={() => send("\x03")} disabled={exited !== undefined}>Stop command</button><button className="terminal-close" onClick={() => void close()} disabled={busy}>Close terminal</button></>}</div></header>
    {error && <p className="ide-error" role="alert">{error}</p>}
    {selected ? <><pre ref={output} className="terminal-output" onClick={() => input.current?.focus({ preventScroll: true })}>{text || "Connecting to shell…"}</pre><div className="terminal-input-row"><span className="terminal-prompt" aria-hidden="true">›</span><textarea ref={input} className="terminal-keyboard" aria-label="Terminal keyboard input" placeholder={exited !== undefined ? `Shell exited (${exited}). Open a new terminal.` : "Type a command…"} disabled={exited !== undefined} rows={1} autoCapitalize="off" autoCorrect="off" spellCheck={false} onChange={event => { if (event.target.value) { send(event.target.value); event.target.value = ""; } }} onPaste={event => { event.preventDefault(); const pasted = event.clipboardData.getData("text"); for (let i = 0; i < pasted.length; i += 16000) send(pasted.slice(i, i + 16000)); }} onKeyDown={event => {
      if (event.ctrlKey && event.shiftKey) return;
      if (event.ctrlKey && event.key.toLowerCase() === "v") return;
      if (event.ctrlKey && event.key.toLowerCase() === "c" && window.getSelection()?.toString()) return;
      const keys: Record<string, string> = { Enter: "\r", Backspace: "\x7f", Tab: "\t", Escape: "\x1b", ArrowUp: "\x1b[A", ArrowDown: "\x1b[B", ArrowRight: "\x1b[C", ArrowLeft: "\x1b[D", Home: "\x1b[H", End: "\x1b[F", Delete: "\x1b[3~" };
      if (event.ctrlKey && /^[a-z]$/i.test(event.key)) { event.preventDefault(); send(String.fromCharCode(event.key.toUpperCase().charCodeAt(0) - 64)); }
      else if (keys[event.key]) { event.preventDefault(); send(keys[event.key]); }
    }}/></div><div className="terminal-shortcuts"><span><kbd>Enter</kbd> Send</span><span><kbd>Tab</kbd> Complete</span><span><kbd>↑</kbd><kbd>↓</kbd> History</span><span><kbd>Ctrl</kbd> + <kbd>C</kbd> Interrupt</span><small>Commands run with your user permissions</small></div></> : <div className="terminal-empty"><span className="terminal-empty-icon" aria-hidden="true">›_</span><h2>Your project, ready to run</h2><p>Open a terminal to use your local tools and start the application.</p><div><code>npm run dev</code><span>or your project's start command</span></div></div>}
    {!!urls.length && <footer><span>Open running application:</span>{urls.map(url => <a key={url} href={url} target="_blank" rel="noreferrer">{url} ↗</a>)}</footer>}
  </section>;
}
