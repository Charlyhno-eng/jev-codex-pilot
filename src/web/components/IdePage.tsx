import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { api } from "../lib/api.js";
import type { ProjectFile, ProjectRecord, TreeNode } from "../lib/types.js";
import { buildTree } from "./ProjectTree.js";
import { GitPage } from "./GitPage.js";
import { ProjectTerminal } from "./ProjectTerminal.js";

function FileEntry({ node, selected, onSelect }: { node: TreeNode; selected: string; onSelect: (path: string) => void }) {
  if (!node.file) return <details><summary>{node.name}</summary><div>{node.children.map(child => <FileEntry key={child.path} node={child} selected={selected} onSelect={onSelect}/>)}</div></details>;
  return <button className={selected === node.path ? "active" : ""} title={node.path} onClick={() => onSelect(node.path)}>{node.name}</button>;
}

function Code({ content }: { content: string }) {
  const tokens = content.split(/(\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b(?:import|from|export|const|let|function|return|class|if|else|async|await|type|interface|new|true|false|null)\b)/g);
  return <code>{tokens.map((token, index) => <span key={index} className={/^\/[/\*]/.test(token) ? "code-comment" : /^["']/.test(token) ? "code-string" : /^(?:import|from|export|const|let|function|return|class|if|else|async|await|type|interface|new|true|false|null)$/.test(token) ? "code-keyword" : undefined}>{token}</span>)}</code>;
}

/** Combines a read-only code explorer, project terminal, and the existing Git workspace. */
export function IdePage() {
  const { id = "" } = useParams();
  const location = useLocation();
  const [tab, setTab] = useState(location.pathname.endsWith("/diff") ? "git" : "ide");
  const [project, setProject] = useState<ProjectRecord>();
  const [files, setFiles] = useState<ProjectFile[]>([]);
  const [selected, setSelected] = useState("");
  const [content, setContent] = useState<string>();
  const [filter, setFilter] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const revision = useRef(0);
  const select = async (path: string) => {
    const version = ++revision.current;
    setSelected(path); setContent(undefined); setError("");
    try { const file = await api<{ content: string }>(`/projects/${id}/files?path=${encodeURIComponent(path)}`); if (version === revision.current) setContent(file.content); }
    catch (reason) { if (version === revision.current) { setError(String(reason)); setContent(""); } }
  };
  const refresh = async () => {
    setLoading(true); setError("");
    try { const result = await api<{ files: ProjectFile[] }>(`/projects/${id}/files`); setFiles(result.files); if (selected && result.files.some(file => file.path === selected)) await select(selected); else { revision.current++; setSelected(""); setContent(undefined); } }
    catch (reason) { setError(String(reason)); } finally { setLoading(false); }
  };
  useEffect(() => { void api<ProjectRecord>(`/projects/${id}`).then(setProject).catch(reason => setError(String(reason))); void refresh(); return () => { revision.current++; }; }, [id]);
  const visible = files.filter(file => file.path.toLowerCase().includes(filter.toLowerCase()));
  const tree = buildTree(visible);
  return <main className="workspace-main ide-page">
    <section className="workspace-hero"><div><Link to={`/projects/${id}`} className="back-link">← Project workspace</Link><p className="eyebrow">DEVELOPMENT WORKSPACE</p><h1>IDE &amp; Git</h1><p>{project?.name} · Browse source, run your application, and review changes.</p></div><span className="ide-readonly">Read-only code</span></section>
    <div className="ide-tabs" role="tablist" aria-label="Development workspace"><button id="ide-tab" role="tab" aria-selected={tab === "ide"} aria-controls="ide-panel" onClick={() => setTab("ide")}>⌘ IDE</button><button id="git-tab" role="tab" aria-selected={tab === "git"} aria-controls="git-panel" onClick={() => setTab("git")}>Δ Git</button></div>
    <div id="ide-panel" role="tabpanel" aria-labelledby="ide-tab" hidden={tab !== "ide"}>
      {error && <p className="ide-error" role="alert">{error}</p>}
      <section className="ide-browser"><aside className="ide-explorer"><header><b>FILES</b><button disabled={loading} onClick={() => void refresh()}>{loading ? "Refreshing…" : "Refresh"}</button></header><input aria-label="Find a file" placeholder="Find a file…" value={filter} onChange={event => setFilter(event.target.value)}/><div className="ide-file-tree">{tree.map(node => <FileEntry key={node.path} node={node} selected={selected} onSelect={path => void select(path)}/>)}{!tree.length && <p>{loading ? "Loading files…" : "No source files found."}</p>}</div><small>{visible.length} files{files.length >= 5000 ? " · Index limited to 5,000 files" : ""} · Private files hidden</small></aside>
      <article className="ide-source"><header><b>{selected || "Source viewer"}</b><span>READ ONLY</span></header>{selected && content !== undefined ? <div className="ide-code"><pre className="ide-line-numbers" aria-hidden="true">{content.split("\n").map((_, index) => index + 1).join("\n")}</pre><pre><Code content={content}/></pre></div> : <div className="ide-empty">{selected ? "Loading file…" : "Select a file to inspect its source. Refresh after tickets finish to see the latest changes."}</div>}</article></section>
      <ProjectTerminal key={id} projectId={id} active={tab === "ide"}/>
    </div>
    <div id="git-panel" role="tabpanel" aria-labelledby="git-tab" hidden={tab !== "git"}>{tab === "git" && <GitPage/>}</div>
  </main>;
}
