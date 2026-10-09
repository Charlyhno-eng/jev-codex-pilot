import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../lib/api.js";
import type { Skill } from "../lib/types.js";
import { WorkspaceHeader } from "./WorkspaceHeader.js";
import "../styles/skills.css";

/** Shows advanced skill usage guidance wherever users inspect or select it. */
export function SkillCaution({ caution }: { caution: Skill["caution"] }) {
  if (!caution) return null;
  return <span className="skill-caution" role="note" aria-label="Advanced skill guidance"><strong><span aria-hidden="true">⚠ </span>{caution.title}</strong><span>{caution.useWhen}</span><span>{caution.avoidWhen}</span></span>;
}

type PortableSkill = Skill & { files: { path: string }[]; content: string };

/** Provides searchable, ticket-only multi-selection from the shared skill library. */
export function SkillPicker({ selected, onChange }: { selected: Skill[]; onChange: (skills: Skill[]) => void }) {
  const [open, setOpen] = useState(false);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const opener = useRef<HTMLButtonElement>(null);
  const close = () => { setOpen(false); opener.current?.focus(); };
  useEffect(() => {
    if (!open) return;
    void api<Skill[]>("/skills").then(setSkills).catch(reason => setError(String(reason)));
  }, [open]);
  const toggle = (skill: Skill) => {
    const included = selected.some(item => item.id === skill.id);
    if (!included && selected.length >= 3) return;
    onChange(included ? selected.filter(item => item.id !== skill.id) : [...selected, skill]);
  };
  return <div className="ticket-skills">
    <button ref={opener} type="button" className="skill-attach" onClick={() => setOpen(true)}>◇ Add skill</button>
    {selected.map(skill => <span className="skill-chip" key={skill.id} title={skill.description}>{skill.name}<button type="button" aria-label={`Remove skill ${skill.name}`} onClick={() => onChange(selected.filter(item => item.id !== skill.id))}>×</button></span>)}
    {selected.map(skill => skill.caution && <SkillCaution key={skill.id} caution={skill.caution}/>)}
    {open && createPortal(<div className="modal-backdrop skill-backdrop" onMouseDown={event => { event.stopPropagation(); close(); }}><div className="skill-picker" role="dialog" aria-modal="true" aria-label="Select ticket skills" onMouseDown={event => event.stopPropagation()} onKeyDown={event => {
      if (event.key === "Escape") { event.stopPropagation(); close(); }
      if (event.key === "Tab") {
        const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input, a[href]'));
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }}>
      <header><div><p className="eyebrow">TICKET SKILLS</p><h2>Choose the right expertise</h2><p>Up to three skills. Applied only to this ticket.</p></div><button type="button" aria-label="Close skill picker" onClick={close}>×</button></header>
      <input autoFocus aria-label="Search skills" placeholder="Search skills…" value={query} onChange={event => setQuery(event.target.value)}/>
      {error && <p role="alert">{error}</p>}
      <div className="skill-options">{skills.filter(skill => `${skill.name} ${skill.description}`.toLowerCase().includes(query.toLowerCase())).map(skill => <button type="button" key={skill.id} aria-pressed={selected.some(item => item.id === skill.id)} disabled={selected.length >= 3 && !selected.some(item => item.id === skill.id)} onClick={() => toggle(skill)}><span>{selected.some(item => item.id === skill.id) ? "✓" : "◇"}</span><div><b>{skill.name}</b><p>{skill.description}</p><SkillCaution caution={skill.caution}/></div></button>)}{!skills.length && !error && <p>Loading the library…</p>}{skills.length > 0 && !skills.some(skill => `${skill.name} ${skill.description}`.toLowerCase().includes(query.toLowerCase())) && <p>No matching skills.</p>}</div>
      {selected.filter(item => !skills.some(skill => skill.id === item.id)).map(skill => <button type="button" key={skill.id} onClick={() => toggle(skill)}>Remove saved skill: {skill.name}</button>)}
      <footer><span>{selected.length} / 3 selected</span><button type="button" onClick={close}>Done</button></footer>
    </div></div>, document.body)}
  </div>;
}

function SkillDetails({ skill, onClose }: { skill: PortableSkill; onClose: () => void }) {
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialog.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => { document.body.style.overflow = overflow; previous?.focus(); };
  }, []);
  return createPortal(<div className="modal-backdrop skill-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={dialog} className="skill-preview" role="dialog" aria-modal="true" aria-labelledby="skill-details-title" onKeyDown={event => {
      if (event.key === "Escape") { event.stopPropagation(); onClose(); }
      if (event.key === "Tab") {
        const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], [tabindex="0"]'));
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }}>
      <header><div><p className="eyebrow">SKILL DETAILS</p><h2 id="skill-details-title">{skill.name.replaceAll("-", " ")}</h2></div><button type="button" onClick={onClose} aria-label="Close skill details">×</button></header>
      <p>{skill.description}</p>
      <SkillCaution caution={skill.caution}/>
      {skill.provenance && <div className="skill-provenance"><a href={skill.provenance.url} target="_blank" rel="noreferrer">{skill.provenance.repository} ↗</a><span>{skill.provenance.license}</span><span>Retrieved {skill.provenance.retrievedAt}</span></div>}
      <details className="skill-resources"><summary>{skill.files.length} included resources</summary><ul>{skill.files.map(file => <li key={file.path}>{file.path}</li>)}</ul></details>
      <pre tabIndex={0} aria-label="Skill instructions">{skill.content}</pre>
    </div>
  </div>, document.body);
}

/** Manages the application-wide library without modifying any target project. */
export function SkillsPage() {
  const [params] = useSearchParams();
  const projectId = params.get("project");
  const [skills, setSkills] = useState<Skill[]>([]);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<PortableSkill>();
  const refresh = () => api<Skill[]>("/skills").then(setSkills);
  useEffect(() => { void refresh().catch(reason => setError(String(reason))); }, []);
  const upload = async (input: FileList | null) => {
    const files = Array.from(input ?? []);
    if (!files.length) return;
    setError(""); setBusy(true);
    try {
      if (files.length > 100 || files.reduce((sum, file) => sum + file.size, 0) > 2 * 1024 * 1024) throw new Error("Import one skill folder with at most 100 files and 2 MB total.");
      const resources = await Promise.all(files.map(async file => {
        const path = file.webkitRelativePath ? file.webkitRelativePath.split("/").slice(1).join("/") : file.name;
        const bytes = new Uint8Array(await file.arrayBuffer());
        let binary = "";
        for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
        return { path, base64: btoa(binary) };
      }));
      await api("/skills", { method: "POST", body: JSON.stringify({ files: resources }) });
      await refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };
  const inspect = async (skill: Skill) => { setError(""); try { setPreview(await api<PortableSkill>(`/skills/${skill.id}`)); } catch (reason) { setError(String(reason)); } };
  const remove = async (skill: Skill) => {
    setBusy(true); setError("");
    try { await api(`/skills/${skill.id}`, { method: "DELETE" }); if (preview?.id === skill.id) setPreview(undefined); await refresh(); }
    catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  };
  const visible = skills.filter(skill => (filter === "all" || (filter === "imported" ? skill.source === "imported" : skill.category === filter)) && `${skill.name} ${skill.description}`.toLowerCase().includes(query.toLowerCase()));
  return <main className="skills-main">
    <WorkspaceHeader backTo={projectId ? `/projects/${projectId}` : "/"} backLabel="Back to workspace" eyebrow="SHARED LIBRARY" title="Skills" description="Reusable expertise for every project. Activate it one ticket at a time."><span className="skills-count">{skills.length} skills</span></WorkspaceHeader>
    <section className="skill-library-intro"><div><h2>A little expertise. A better result.</h2><p>Skills for interface design, performance, project architecture, README writing, and advanced Rust optimization. Published skills include their source and license; the README skill follows your writing guidelines. Import your own SKILL.md or its complete folder, including references, scripts, and assets. Removing an imported skill preserves existing ticket copies.</p></div><div className="skill-import-actions"><label aria-disabled={busy}><input type="file" accept=".md" disabled={busy} onChange={event => { void upload(event.currentTarget.files); event.currentTarget.value = ""; }}/>＋ Import SKILL.md</label><label aria-disabled={busy}><input type="file" multiple {...{ webkitdirectory: "", directory: "" }} disabled={busy} onChange={event => { void upload(event.currentTarget.files); event.currentTarget.value = ""; }}/>＋ Import folder</label><small>One skill · up to 2 MB / 100 files</small></div></section>
    {error && <p className="agents-error" role="alert">{error}</p>}
    <div className="skill-library-tools"><input aria-label="Search skill library" placeholder="Search the library…" value={query} onChange={event => setQuery(event.target.value)}/><div>{["all", "design", "performance", "architecture", "documentation", "imported"].map(value => <button type="button" key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{value}</button>)}</div></div>
    <div className="skill-library-grid">{visible.map(skill => <article key={skill.id} className={`skill-card ${skill.category === "design" ? "skill-design" : "skill-performance"}${skill.caution ? " skill-advanced" : ""}`}><header><span className="skill-symbol">{skill.category === "design" ? "✧" : "↗"}</span><small>{skill.provenance ? skill.provenance.repository.split("/")[0] : skill.source === "built-in" ? "JEV" : "IMPORTED"}</small></header><h3>{skill.name.replaceAll("-", " ")}</h3><p>{skill.description}</p><SkillCaution caution={skill.caution}/><footer><span>{skill.fileCount} file{skill.fileCount === 1 ? "" : "s"}</span><button type="button" onClick={() => void inspect(skill)}>View instructions ↗</button>{skill.source === "imported" && <button type="button" disabled={busy} onClick={() => void remove(skill)} aria-label={`Remove ${skill.name}`}>Remove</button>}</footer></article>)}</div>
    {!visible.length && <p className="skills-empty">No skills match your search.</p>}
    {preview && <SkillDetails skill={preview} onClose={() => setPreview(undefined)}/>}
  </main>;
}
