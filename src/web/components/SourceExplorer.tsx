import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../lib/api.js";
import type { ProjectFile, TreeNode } from "../lib/types.js";
import { buildTree } from "./ProjectTree.js";

function FileEntry({ node, selected, onSelect }: { node: TreeNode; selected: string; onSelect: (path: string) => void }) {
  if (!node.file) return <details><summary>{node.name}</summary><div>{node.children.map(child => <FileEntry key={child.path} node={child} selected={selected} onSelect={onSelect}/>)}</div></details>;
  return <button className={selected === node.path ? "active" : ""} title={node.path} onClick={() => onSelect(node.path)}>{node.name}</button>;
}

function Code({ content }: { content: string }) {
  const tokens = content.split(/(\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b(?:import|from|export|const|let|function|return|class|if|else|async|await|type|interface|new|true|false|null)\b)/g);
  return <code>{tokens.map((token, index) => <span key={index} className={/^\/\/|^\/\*/.test(token) ? "code-comment" : /^["']/.test(token) ? "code-string" : /^(?:import|from|export|const|let|function|return|class|if|else|async|await|type|interface|new|true|false|null)$/.test(token) ? "code-keyword" : undefined}>{token}</span>)}</code>;
}

/** Shows the workspace file tree and opens source in a read-only dialog. */
export const SourceExplorer = memo(function SourceExplorer({ projectId: id }: { projectId: string }) {
  const [files, setFiles] = useState<ProjectFile[]>([]);
  const [selected, setSelected] = useState("");
  const [content, setContent] = useState<string>();
  const [filter, setFilter] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const revision = useRef(0);
  const selectedRef = useRef(selected);
  const select = useCallback(async (path: string) => {
    const version = ++revision.current;
    setSelected(path); setContent(undefined); setError("");
    try { const file = await api<{ content: string }>(`/projects/${id}/files?path=${encodeURIComponent(path)}`); if (version === revision.current) setContent(file.content); }
    catch (reason) { if (version === revision.current) { setError(String(reason)); setContent(""); } }
  }, [id]);
  const refresh = useCallback(async () => {
    setLoading(true); setError("");
    try { const result = await api<{ files: ProjectFile[] }>(`/projects/${id}/files`); setFiles(result.files); const currentPath = selectedRef.current; if (currentPath && result.files.some(file => file.path === currentPath)) await select(currentPath); else { revision.current++; setSelected(""); setContent(undefined); } }
    catch (reason) { setError(String(reason)); } finally { setLoading(false); }
  }, [id, select]);
  const invalidateSelection = useCallback(() => { revision.current++; }, []);
  useEffect(() => { selectedRef.current = selected; }, [selected]);
  useEffect(() => { void refresh(); return invalidateSelection; }, [invalidateSelection, refresh]);
  const visible = useMemo(() => { const query = filter.toLowerCase(); return files.filter(file => file.path.toLowerCase().includes(query)); }, [files, filter]);
  const tree = useMemo(() => buildTree(visible), [visible]);
  return <aside className="workspace-explorer">
      <section className="ide-explorer"><header><b>PROJECT FILES</b><button disabled={loading} onClick={() => void refresh()}>{loading ? "Refreshing…" : "Refresh"}</button></header><input aria-label="Find a file" placeholder="Find a file…" value={filter} onChange={event => setFilter(event.target.value)}/><div className="ide-file-tree">{tree.map(node => <FileEntry key={node.path} node={node} selected={selected} onSelect={path => void select(path)}/>)}{!tree.length && <p>{loading ? "Loading files…" : "No source files found."}</p>}</div><small>{visible.length} files{files.length >= 5000 ? " · Index limited to 5,000 files" : ""} · Private files hidden</small>{!selected && error && <p className="ide-error" role="alert">{error}</p>}</section>
      {selected && createPortal(<div className="modal-backdrop" onMouseDown={() => { revision.current++; setSelected(""); }}><article className="ide-source source-dialog" role="dialog" aria-modal="true" aria-label={`Source: ${selected}`} onMouseDown={event => event.stopPropagation()} onKeyDown={event => { if (event.key === "Escape") { revision.current++; setSelected(""); } }}><header><b>{selected}</b><span>READ ONLY</span><button type="button" autoFocus aria-label="Close source viewer" onClick={() => { revision.current++; setSelected(""); }}>×</button></header>{error && <p className="ide-error" role="alert">{error}</p>}{content !== undefined ? <div className="ide-code"><pre className="ide-line-numbers" aria-hidden="true">{content.split("\n").map((_, index) => index + 1).join("\n")}</pre><pre><Code content={content}/></pre></div> : <div className="ide-empty">Loading file…</div>}</article></div>, document.body)}
  </aside>;
});
