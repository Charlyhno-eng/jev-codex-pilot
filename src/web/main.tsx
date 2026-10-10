import { TaskComposer, type SubmittedTask } from "./components/TaskComposer.js";
import { readDraftImage } from "./lib/draft-images.js";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Link, Route, Routes, useNavigate, useParams } from "react-router-dom";
import "./styles/index.css";
import logoUrl from "../../assets/jev-codex-pilot-logo2.png";

const favicon = document.createElement("link");
favicon.id = "app-favicon";
favicon.rel = "icon";
favicon.type = "image/png";
favicon.href = logoUrl;
document.head.appendChild(favicon);

import { api } from "./lib/api.js";
import type { DraftAttachment, Job, ProjectIndex, ProjectRecord, Settings } from "./lib/types.js";
import { SkillPicker, SkillsPage } from "./components/Skills.js";
import type { Skill } from "./lib/types.js";
import { QueueBoard, Status } from "./components/QueueBoard.js";
import { IdePage } from "./components/IdePage.js";
import { Plan } from "./components/Plan.js";
import { ExecutionPanel } from "./components/ExecutionPanel.js";
import { SourceExplorer } from "./components/SourceExplorer.js";
import { ProjectLanguages } from "./components/ProjectLanguages.js";
import { WorkspaceHeader } from "./components/WorkspaceHeader.js";
import { useTaskCompletionPing } from "./hooks/use-task-completion-ping.js";
import { useBilling } from "./hooks/use-jev-data.js";
import { useJobs } from "./hooks/use-jobs.js";
import { useBrowserTabIndicator } from "./hooks/use-browser-tab-indicator.js";

function Shell({ children, project }: { children: React.ReactNode; project?: ProjectRecord }) {
  const { billing, error } = useBilling(); const [settingsOpen, setSettingsOpen] = useState(false);
  useBrowserTabIndicator();
  return <div className="app"><header className="topbar"><Link className="brand" to="/"><img className="brand-logo" src={logoUrl} alt=""/><span>JEV Codex Pilot</span></Link><nav><span className="topbar-divider" aria-hidden="true">|</span><Link to="/">Projects</Link><span className="topbar-divider" aria-hidden="true">|</span><Link to="/skills">Skills</Link>{project && <><span className="topbar-divider" aria-hidden="true">|</span><span className="nav-project"><i/> {project.name}</span></>}</nav><a className="credit-pill" href={billing?.dashboardUrl ?? "https://vercel.com/ai-gateway"} target="_blank" rel="noreferrer" title={error || "Live balance retrieved from Vercel AI Gateway."}><span><small>VERCEL AI GATEWAY CREDITS</small><b>{billing ? `$${billing.balance.toFixed(4)}` : error ? "Unavailable" : "—"}</b></span><i>{billing ? "live" : "unavailable"}</i></a><button className="settings-button" type="button" onClick={() => setSettingsOpen(true)} aria-label="Open settings" title="Settings">⚙</button></header>{children}{settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)}/>}</div>;
}

function ProjectsHome() {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [context, setContext] = useState("");
  const [contextOpen, setContextOpen] = useState(false);
  const [projectIndex, setProjectIndex] = useState<ProjectIndex>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const refreshProjects = async () => { const [nextProjects, nextJobs] = await Promise.all([api<ProjectRecord[]>("/projects"), api<Job[]>("/jobs?view=summary")]); setProjects(nextProjects); setJobs(nextJobs); };
  useEffect(() => { void refreshProjects(); }, []);
  const inspect = async () => { if (!path.trim()) return; try { const result = await api<ProjectIndex>(`/project?path=${encodeURIComponent(path.trim())}`); setProjectIndex(result); } catch { setProjectIndex(undefined); } };
  const browse = async () => { setError(""); try { const result = await api<{ path: string }>("/system/select-directory", { method: "POST" }); setPath(result.path); if (!name) setName(result.path.split("/").pop() ?? ""); const inspected = await api<ProjectIndex>(`/project?path=${encodeURIComponent(result.path)}`); setProjectIndex(inspected); } catch (reason) { if (!/cancelled/i.test(String(reason))) setError(reason instanceof Error ? reason.message : String(reason)); } };
  const create = async (event: React.FormEvent) => { event.preventDefault(); if (!path) return; setBusy(true); setError(""); try { const index = await api<ProjectIndex>(`/project?path=${encodeURIComponent(path.trim())}`); setProjectIndex(index); if (!index.hasAgents && !context.trim()) { setContextOpen(true); return; } const project = await api<ProjectRecord>("/projects", { method: "POST", body: JSON.stringify({ path, name, context }) }); navigate(`/projects/${project.id}`); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(false); } };
  const createWithContext = async () => { setBusy(true); setError(""); try { const project = await api<ProjectRecord>("/projects", { method: "POST", body: JSON.stringify({ path, name, context }) }); setContextOpen(false); navigate(`/projects/${project.id}`); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(false); } };
  const removeProject = async (project: ProjectRecord) => {
    const confirmed = window.confirm(`Remove "${project.name}" from JEV Codex Pilot?\n\nThis only removes the workspace from this application. The project folder, its files, and local task history will not be deleted. Re-adding the same folder restores its workspace history.`);
    if (!confirmed) return;
    setError("");
    try { await api<ProjectRecord>(`/projects/${project.id}`, { method: "DELETE" }); await refreshProjects(); setNotice("Project removed from JEV Codex Pilot"); window.setTimeout(() => setNotice(""), 2800); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  return <Shell><main className="home-main"><section className="home-hero"><div><p className="eyebrow">LOCAL DEVELOPMENT WORKSPACE</p><h1>Every project.<br/><em>One clear cockpit.</em></h1><p>Create a workspace once, keep its task history, and watch independent Codex sessions move your products forward.</p></div><div className="fleet-stats"><span><b>{projects.length}</b>PROJECTS</span><span><b>{jobs.filter(job => job.status === "RUNNING" || job.status === "ESCALATING").length}</b>LIVE RUNS</span><span><b>{jobs.filter(job => job.status === "SUCCESS").length}</b>COMPLETED</span></div></section>
    <section className="project-launcher"><div className="launcher-copy"><span className="step">01</span><div><h2>Open a project</h2><p>JEV checks the folder first, then creates a useful initial AGENTS.md only when one is absent.</p></div></div><form onSubmit={create}><input value={name} onChange={event => setName(event.target.value)} placeholder="Project name"/><div className="new-project-path"><input value={path} onChange={event => setPath(event.target.value)} onBlur={() => void inspect()} placeholder="Absolute folder path"/><button type="button" onClick={browse}>Browse</button></div>{projectIndex && <p className={`repository-status ${projectIndex.isGithubLinked ? "git" : "plain"}`}><b>{projectIndex.isGithubLinked ? "GitHub linked" : projectIndex.isGitRepository ? "No GitHub remote" : "No Git repository"}</b><span>{projectIndex.isGithubLinked ? "This project has a GitHub remote." : "JEV can still work with this local project."}</span></p>}<button className="create-project" disabled={!path || busy}>{busy ? "Creating…" : "Create Workspace"}<span>→</span></button></form>{error && <div className="alert"><b>Project could not be opened</b><span>{error}</span></div>}</section>
    <section className="project-library"><div className="section-heading"><span className="step">02</span><div><h2>Your projects</h2><p>Each project keeps its own queue, history and Codex thread.</p></div></div>{projects.length ? <div className="project-grid">{projects.map(project => { const projectJobs = jobs.filter(job => job.projectId === project.id); const running = projectJobs.filter(job => job.status === "RUNNING" || job.status === "ESCALATING").length; return <div key={project.id} className="project-card-wrap"><button className="project-card" onClick={() => navigate(`/projects/${project.id}`)}><span className="project-letter">{project.name.slice(0, 1).toUpperCase()}</span><div><h3>{project.name}</h3><p>{project.path}</p><ProjectLanguages languages={project.languages} linterConfigured={project.linterConfigured}/><small>{projectJobs.length} tasks · {projectJobs.filter(job => job.status === "SUCCESS").length} completed</small></div><span className={running ? "project-live active" : "project-live"}><i/>{running ? `${running} live` : "idle"}</span><b>↗</b></button><button className="remove-project" type="button" onClick={() => void removeProject(project)} disabled={Boolean(running)} title={running ? "Wait for the active Codex execution to finish" : "Remove this project from JEV Codex Pilot"}>Remove</button></div>; })}</div> : <div className="empty-projects"><span>⌁</span><h3>No project registered yet</h3><p>Choose a local folder above to create your first workspace.</p></div>}</section></main>{contextOpen && <InitialAgentsModal context={context} onChange={setContext} onClose={() => setContextOpen(false)} onCreate={() => void createWithContext()} busy={busy} error={error}/>} {notice && <div className="toast">✓ {notice}</div>}</Shell>;
}

function ProjectWorkspaceRoute() {
  const { id } = useParams();
  return <ProjectWorkspace key={id} />;
}

function ProjectWorkspace() {
  const { id = "" } = useParams();
  const [record, setRecord] = useState<ProjectRecord>();
  const [project, setProject] = useState<ProjectIndex>();
  const { jobs, refresh, error: pollingError } = useJobs(id);
  const [selectedId, setSelectedId] = useState<string>();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [agentsOpen, setAgentsOpen] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [editingJob, setEditingJob] = useState<Job>();
  const resultRef = useRef<HTMLElement>(null);
  const queueRef = useRef<HTMLDivElement>(null);
  const selected = jobs.find(job => job.id === selectedId);
  const { notices, dismissNotice } = useTaskCompletionPing(jobs, id);

  useEffect(() => { setSelectedId(current => jobs.find(job => job.id === current)?.id ?? jobs.find(job => job.status === "RUNNING" || job.status === "ESCALATING")?.id ?? jobs.find(job => !job.archivedAt && job.status !== "SKIPPED")?.id); }, [jobs]);
  const completedTicketIds = jobs.filter(job => job.status === "SUCCESS").map(job => job.id).join(",");
  useEffect(() => { void api<ProjectRecord>(`/projects/${id}`).then(async next => { setRecord(next); setProject(await api<ProjectIndex>(`/project?path=${encodeURIComponent(next.path)}`)); }).catch(reason => setError(reason instanceof Error ? reason.message : String(reason))); }, [id, completedTicketIds]);

  const createTickets = useCallback(async (tasks: SubmittedTask[]) => {
    setError("");
    const created = await api<Job[]>("/jobs", { method: "POST", body: JSON.stringify({ projectId: id, tasks, run: true }) });
    setSelectedId(created[0].id);
    await refresh().catch(() => undefined);
    window.setTimeout(() => queueRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  }, [id, refresh]);
  const launchBatch = useCallback(async () => {
    const next = jobs.find(job => job.projectId === id && !job.archivedAt && job.status === "PENDING");
    if (!next || launching) return;
    setError(""); setLaunching(true);
    try { await api<Job>(`/jobs/${next.id}/run-batch`, { method: "POST" }); await refresh(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setLaunching(false); }
  }, [id, jobs, launching, refresh]);
  const archive = async (job: Job, actionName: "archive" | "unarchive") => { setError(""); try { await api<Job>(`/jobs/${job.id}/${actionName}`, { method: "POST" }); if (actionName === "archive" && selectedId === job.id) setSelectedId(undefined); await refresh(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } };
  const reviewJobs = jobs.filter(job => !job.archivedAt && job.status !== "SKIPPED").sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const reviewIndex = selected ? reviewJobs.findIndex(job => job.id === selected.id) : -1;
  const selectReviewJob = (offset: number) => {
    const next = reviewJobs[reviewIndex + offset];
    if (!next) return;
    setSelectedId(next.id);
    window.setTimeout(() => resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 20);
  };
  const projectRunning = jobs.some(job => job.projectBusy || job.status === "RUNNING" || job.status === "ESCALATING");
  const reviewTicket = record?.humanInTheLoop ? jobs.find(job => job.awaitingHumanReview) : undefined;
  const launchLocked = launching || projectRunning || Boolean(reviewTicket);
  const pendingCount = jobs.filter(job => !job.archivedAt && job.status === "PENDING").length;
  if (!record) return <Shell><main><div className="loading-state">{error || "Opening project…"}</div></main></Shell>;
  if (project && !project.hasAgents) return <Shell project={record}><main className="workspace-main"><WorkspaceHeader backTo="/" backLabel="All projects" eyebrow="PROJECT SETUP" title={record.name} description={record.path} languages={record.languages} linterConfigured={record.linterConfigured}/><section className="workspace-layout"><aside/><AgentsSetup projectId={id} onReady={() => setProject(current => current ? { ...current, hasAgents: true } : current)}/></section></main></Shell>;
  return <Shell project={record}><main className="workspace-main project-board-page"><WorkspaceHeader backTo="/" backLabel="All projects" eyebrow="PROJECT WORKSPACE" title={record.name} description={record.path} languages={record.languages} linterConfigured={record.linterConfigured}><div className="project-overview"><span><b>{jobs.filter(job => job.status === "PENDING").length}</b>TO DO</span><span><b>{jobs.filter(job => job.status === "RUNNING" || job.status === "ESCALATING").length}</b>ACTIVE</span><span><b>{jobs.filter(job => job.status === "SESSION_PAUSED").length}</b>PAUSED</span><span><b>{jobs.filter(job => job.status === "SUCCESS").length}</b>DONE</span></div></WorkspaceHeader>
    <nav className="project-toolbar" aria-label="Project tools"><span className="board-tab">▦ Board</span><button type="button" onClick={() => setAgentsOpen(true)}>↗ Application context</button><Link to={`/projects/${id}/git`}>⌘ Git</Link><Link to={`/projects/${id}/console${selected?.execution || selected?.error ? `/${selected.id}` : ""}`}>›_ Codex console</Link><Link to={`/skills?project=${id}`}>◇ Skills</Link><section className="human-review-settings"><label><input type="checkbox" checked={Boolean(record.humanInTheLoop)} disabled={busy === "review-settings"} onChange={async event => { const enabled = event.target.checked; setBusy("review-settings"); try { const updated = await api<ProjectRecord>(`/projects/${id}`, { method: "PUT", body: JSON.stringify({ humanInTheLoop: enabled }) }); setRecord(updated); await refresh(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(""); } }}/><b>Human in the loop</b></label><p>Wait for your approval after each ticket before continuing.</p></section></nav>
    <div className="project-board-layout"><SourceExplorer key={id} projectId={id}/><div className="project-board-content">
    <div ref={queueRef}><QueueBoard jobs={jobs} selectedId={selectedId} composer={
      <TaskComposer pendingCount={pendingCount} executionBlocked={launchLocked} launching={launching} externalError={error || pollingError} onCreate={createTickets} onRun={launchBatch}/>
    } onSelect={job => { setSelectedId(job.id); window.setTimeout(() => resultRef.current?.scrollIntoView({ behavior: "smooth" }), 20); }} onArchive={archive} onEdit={setEditingJob} onReorder={async (job, beforeId) => { setError(""); try { await api<Job>(`/jobs/${job.id}/reorder`, { method: "POST", body: JSON.stringify({ beforeId }) }); await refresh(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } }} onMove={async (job, status) => { try { await api<Job>(`/jobs/${job.id}/move`, { method: "POST", body: JSON.stringify({ status }) }); await refresh(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } }}/></div>
    {reviewTicket && <section className="human-review-panel" role="status"><div><h3>Waiting for your review</h3><p>{reviewTicket.tasks[0]?.description}</p><p>Review the result. If it needs changes, return the ticket to To do, edit it, then raise its model or reasoning level below.</p></div><button type="button" className="launch" disabled={projectRunning || busy === "continue"} onClick={async () => { setBusy("continue"); setError(""); try { await api(`/jobs/${reviewTicket.id}/continue`, { method: "POST" }); await refresh(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(""); } }}>{busy === "continue" ? "Continuing…" : pendingCount ? "Continue" : "Approve final ticket"}</button></section>}
    {selected && <section className="result-section" ref={resultRef}><div className="section-kicker"><div><p className="eyebrow">TASK {reviewIndex + 1} OF {reviewJobs.length} · PROJECT THREAD</p><h2>{selected.tasks[0]?.description}</h2><span>{selected.projectPath}</span></div><div className="task-review-nav"><button type="button" onClick={() => selectReviewJob(-1)} disabled={reviewIndex <= 0} aria-label="Previous task" title="Previous task">←</button><span>{reviewIndex + 1} / {reviewJobs.length}</span><button type="button" onClick={() => selectReviewJob(1)} disabled={reviewIndex < 0 || reviewIndex >= reviewJobs.length - 1} aria-label="Next task" title="Next task">→</button><Status status={selected.status}/></div></div>{selected.analysis && <Plan analysis={selected.analysis} adjustable={selected.status === "PENDING"} onAdjust={async (dimension, delta) => { try { await api<Job>(`/jobs/${selected.id}/adjust`, { method: "POST", body: JSON.stringify({ dimension, delta }) }); await refresh(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } }}/>}<div className="mission-actions">{selected.status === "PENDING" && <button className="secondary" disabled={projectRunning || busy === "reevaluate"} onClick={async () => { setBusy("reevaluate"); try { await api<Job>(`/jobs/${selected.id}/prepare`, { method: "POST", body: JSON.stringify({ reevaluate: true }) }); await refresh(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(""); } }}>Re-evaluate ticket</button>}<button className="launch" disabled={launchLocked || pendingCount === 0} onClick={() => void launchBatch()}>{launching ? "Starting…" : projectRunning ? "Sequence running" : `Launch ${pendingCount} task${pendingCount === 1 ? "" : "s"}`}<span>↗</span></button></div></section>}
    </div></div></main><div className="ticket-notices" aria-live="polite" aria-relevant="additions">{notices.map(notice => <div key={notice.id} className={`ticket-notice ticket-notice-${notice.status.toLowerCase()}`}><span aria-hidden="true">{notice.status === "SUCCESS" ? "✓" : notice.status === "FAILED" ? "!" : "↗"}</span><div><b>{notice.title}</b><p>{notice.description}</p></div><button type="button" aria-label={`Dismiss ${notice.title}`} onClick={() => dismissNotice(notice.id)}>×</button></div>)}</div>{agentsOpen && <ProjectAgentsModal projectId={id} onClose={() => setAgentsOpen(false)}/>} {editingJob && <TaskEditorModal job={editingJob} onClose={() => setEditingJob(undefined)} onSave={async (description, images, skillIds) => { const updated = await api<Job>(`/jobs/${editingJob.id}/edit`, { method: "POST", body: JSON.stringify({ description, skillIds, attachments: images.length ? images : undefined }) }); await refresh(); setSelectedId(updated.id); setEditingJob(undefined); setToast("Task updated and re-evaluated by JEV"); window.setTimeout(() => setToast(""), 2600); }} onRemove={async () => { await api<{ removed: boolean }>(`/jobs/${editingJob.id}/remove`, { method: "POST" }); if (selectedId === editingJob.id) setSelectedId(undefined); await refresh(); setEditingJob(undefined); setToast("Task permanently removed"); window.setTimeout(() => setToast(""), 2600); }}/>} {toast && <div className="toast">✓ {toast}</div>}</Shell>;
}

function InitialAgentsModal({ context, onChange, onClose, onCreate, busy, error }: { context: string; onChange: (value: string) => void; onClose: () => void; onCreate: () => void; busy: boolean; error: string }) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={onClose}><section className="agents-modal" role="dialog" aria-modal="true" aria-label="Create AGENTS.md" onMouseDown={event => event.stopPropagation()}><header><div><p className="eyebrow">PROJECT CONTEXT</p><h2>Create AGENTS.md</h2><span>Describe the application, its users, stack, and working rules. JEV will create the initial project instructions from this text.</span></div><button type="button" onClick={onClose} aria-label="Close AGENTS.md">×</button></header><div className="agents-modal-body"><textarea autoFocus value={context} onChange={event => onChange(event.target.value)} placeholder="What is this application, who is it for, and what constraints matter?" spellCheck={false}/>{error && <p className="agents-error">{error}</p>}</div><footer><span>You can edit the complete AGENTS.md later from the project workspace.</span><div><button type="button" className="modal-secondary" onClick={onClose}>Close</button><button type="button" className="modal-primary" onClick={onCreate} disabled={busy || !context.trim()}>{busy ? "Creating…" : "Create workspace"}</button></div></footer></section></div>;
}

function ConsolePage() {
  const { id = "", jobId } = useParams();
  const [record, setRecord] = useState<ProjectRecord>();
  const { jobs, error: pollingError } = useJobs(id, jobId ?? "latest");
  const [error, setError] = useState("");
  useEffect(() => { void api<ProjectRecord>(`/projects/${id}`).then(setRecord).catch(reason => setError(reason instanceof Error ? reason.message : String(reason))); }, [id]);
  const available = jobs.filter(job => job.execution || job.error).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const selected = available.find(job => job.id === jobId) ?? available.find(job => job.status === "RUNNING" || job.status === "ESCALATING") ?? available[0];
  if (!record) return <Shell><main><div className="loading-state">{error || "Opening console…"}</div></main></Shell>;
  return <Shell project={record}><main className="workspace-main console-page"><WorkspaceHeader backTo={`/projects/${id}`} backLabel="Project workspace" eyebrow="CODEX EXECUTION" title="Console" description={record.name}/>{selected ? <div className="console-workbench"><aside className="console-history"><header><div><p className="panel-label">TICKET HISTORY</p><h2>{available.length} execution{available.length === 1 ? "" : "s"}</h2></div></header><nav aria-label="Ticket history">{available.map(job => <Link key={job.id} to={`/projects/${id}/console/${job.id}`} className={selected.id === job.id ? "active" : ""}><span className={`console-history-state ${job.status.toLowerCase()}`}/><div><b>{job.tasks[0]?.description || "Untitled task"}</b><small>{new Date(job.createdAt).toLocaleDateString()} · {consoleStatusLabel(job.status)}</small></div><i>→</i></Link>)}</nav></aside><section className="console-result"><header><div><p className="panel-label">TICKET ACTIVITY</p><h2>{selected.tasks[0]?.description}</h2></div><Status status={selected.status}/></header><ExecutionPanel job={selected}/></section></div> : <div className="loading-state">No Codex execution yet. Launch a task to see its console here.</div>}{(error || pollingError) && <div className="alert">{error || pollingError}</div>}</main></Shell>;
}

function consoleStatusLabel(status: string) { return status === "SUCCESS" ? "Done" : status === "SESSION_PAUSED" ? "Paused" : status === "FAILED" ? "Needs attention" : status === "RUNNING" ? "Running" : status === "ESCALATING" ? "Escalating" : status; }

function TaskEditorModal({ job, onClose, onSave, onRemove }: { job: Job; onClose: () => void; onSave: (description: string, images: Array<Pick<DraftAttachment, "name" | "mimeType" | "base64">>, skillIds: string[]) => Promise<void>; onRemove: () => Promise<void> }) { const [description, setDescription] = useState(job.tasks[0]?.description ?? ""); const [selectedSkills, setSelectedSkills] = useState<Skill[]>(job.skills ?? []); const [images, setImages] = useState<DraftAttachment[]>([]); const [error, setError] = useState(""); const [busy, setBusy] = useState(false); const add = async (files: FileList | null) => { const candidates = Array.from(files ?? []); if (!candidates.length) return; if (candidates.some(file => !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.type) || file.size > 5 * 1024 * 1024)) { setError("Use PNG, JPEG, GIF, or WebP images no larger than 5 MB."); return; } if ((job.attachments?.length ?? 0) + images.length + candidates.length > 4) { setError("Attach at most four images to one task, including existing references."); return; } try { const nextImages = await Promise.all(candidates.map(readDraftImage)); setImages(current => [...current, ...nextImages]); setError(""); } catch { setError("The selected image could not be read."); } }; const submit = async (event: React.FormEvent) => { event.preventDefault(); setBusy(true); setError(""); try { await onSave(description, images.map(({ name, mimeType, base64 }) => ({ name, mimeType, base64 })), selectedSkills.map(skill => skill.id)); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); setBusy(false); } }; const remove = async () => { if (!window.confirm("Permanently remove this pending task? This cannot be undone.")) return; setBusy(true); setError(""); try { await onRemove(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); setBusy(false); } }; return <div className="modal-backdrop" role="presentation" onMouseDown={onClose}><form className="task-editor-modal" role="dialog" aria-modal="true" aria-label="Edit pending task" onMouseDown={event => event.stopPropagation()} onSubmit={submit}><header><div><p className="eyebrow">PENDING TASK</p><h2>Edit and re-evaluate</h2><span>Changing the wording replaces the previous JEV recommendation. New images will be passed to Codex when this ticket runs.</span></div><button type="button" onClick={onClose} aria-label="Close task editor">×</button></header><textarea autoFocus value={description} onChange={event => setDescription(event.target.value)} rows={7} placeholder="Describe the intended outcome…"/><div className="editor-attachments"><div><b>Visual references</b><small>Optional · PNG, JPEG, GIF, or WebP · max 5 MB each</small></div><label className="attach-image"><input type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple onChange={event => { void add(event.currentTarget.files); event.currentTarget.value = ""; }}/><span>＋ Add image</span></label>{images.length > 0 && <div className="editor-image-list">{images.map(image => <figure key={image.id}><img src={image.previewUrl} alt="New task reference"/><figcaption>{image.name}</figcaption><button type="button" onClick={() => setImages(current => current.filter(candidate => candidate.id !== image.id))}>×</button></figure>)}</div>}</div><SkillPicker selected={selectedSkills} onChange={setSelectedSkills}/>{error && <p className="agents-error">{error}</p>}<footer><button type="button" className="modal-danger" onClick={() => void remove()} disabled={busy}>Remove task</button><span/><button type="button" className="modal-secondary" onClick={onClose}>Cancel</button><button className="modal-primary" disabled={busy || !description.trim()}>{busy ? "Re-evaluating…" : "Save & re-evaluate"}</button></footer></form></div>; }
function AgentsSetup({ projectId, onReady }: { projectId: string; onReady: () => void }) { const [context, setContext] = useState(""); const [error, setError] = useState(""); const [busy, setBusy] = useState(false); const submit = async (event: React.FormEvent) => { event.preventDefault(); setBusy(true); setError(""); try { await api<ProjectRecord>(`/projects/${projectId}/agents`, { method: "POST", body: JSON.stringify({ context }) }); onReady(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(false); } }; return <form className="setup-card" onSubmit={submit}><div className="section-heading"><span className="step">01</span><div><h2>Describe this application</h2><p>AGENTS.md is required before JEV can analyze work. JEV creates concise instructions from this context.</p></div></div><textarea className="project-context" value={context} onChange={event => setContext(event.target.value)} placeholder="What is this application, who is it for, and what constraints matter?" required rows={8}/>{error && <div className="alert"><b>AGENTS.md could not be created</b><span>{error}</span></div>}<div className="submit-row"><div><b>Required project context</b><span>Keep lasting project instructions short and useful.</span></div><button className="analyze-button" disabled={busy || !context.trim()}>{busy ? "Creating…" : "Create AGENTS.md"}<span>→</span></button></div></form>; }
function ProjectAgentsModal({ projectId, onClose }: { projectId: string; onClose: () => void }) { const [content, setContent] = useState<string>(); const [error, setError] = useState(""); const [busy, setBusy] = useState(false); useEffect(() => { void (async () => { setBusy(true); try { setContent((await api<{ content: string }>(`/projects/${projectId}/agents`)).content); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(false); } })(); }, [projectId]); const save = async () => { if (content === undefined) return; setBusy(true); setError(""); try { await api<{ content: string }>(`/projects/${projectId}/agents`, { method: "PUT", body: JSON.stringify({ content }) }); onClose(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(false); } }; return <div className="modal-backdrop" role="presentation" onMouseDown={onClose}><section className="agents-modal" role="dialog" aria-modal="true" aria-label="Application context" onMouseDown={event => event.stopPropagation()}><header><div><p className="eyebrow">PROJECT CONTEXT</p><h2>AGENTS.md</h2><span>The complete instructions used by Codex for this project.</span></div><button type="button" onClick={onClose} aria-label="Close AGENTS.md">×</button></header><div className="agents-modal-body">{busy && content === undefined ? <p>Loading AGENTS.md…</p> : content !== undefined && <textarea autoFocus value={content} onChange={event => setContent(event.target.value)} spellCheck={false}/>} {error && <p className="agents-error">{error}</p>}</div><footer><span>Changes apply to this project’s AGENTS.md immediately.</span><div><button type="button" className="modal-secondary" onClick={onClose}>Close</button><button type="button" className="modal-primary" onClick={() => void save()} disabled={busy || !content?.trim()}>{busy ? "Saving…" : "Save AGENTS.md"}</button></div></footer></section></div>; }
function SettingsDialog({ onClose }: { onClose: () => void }) {
  const [settings, setSettings] = useState<Settings>();
  const [apiKey, setApiKey] = useState("");
  const [apiKeyVisible, setApiKeyVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { void Promise.all([api<Settings>("/settings"), api<{ apiKey: string }>("/settings/secrets")]).then(([value, secrets]) => { setSettings(value); setApiKey(secrets.apiKey); }).catch(reason => setError(reason instanceof Error ? reason.message : String(reason))); }, []);
  const reveal = async () => {
    if (apiKeyVisible) { setApiKeyVisible(false); return; }
    setBusy(true); setError("");
    try {
      const secrets = await api<{ apiKey: string }>("/settings/secrets");
      setApiKey(secrets.apiKey); setApiKeyVisible(true);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(false); }
  };
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const payload: Record<string, unknown> = {};
      if (apiKey.trim()) payload.apiKey = apiKey.trim();
      const result = await api<Settings>("/settings", { method: "PUT", body: JSON.stringify(payload) });
      setSettings(result); setApiKeyVisible(false);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(false); }
  };
  return <div className="modal-backdrop" role="presentation" onMouseDown={onClose}><form className="settings-modal" role="dialog" aria-modal="true" aria-label="Settings" onMouseDown={event => event.stopPropagation()} onSubmit={save}>
    <header><div><p className="eyebrow">SETTINGS</p><h2>Local integrations</h2><span>Private credentials remain on this computer in <code>config/config.toml</code>.</span></div><button type="button" onClick={onClose} aria-label="Close settings">×</button></header>
    <section className="settings-section"><b>Vercel AI Gateway</b><label>API key for JEV <span>{settings?.configured ? `Configured: ${settings.maskedApiKey}.` : "Paste a key to enable JEV analysis."}</span><div className="secret-field"><input type={apiKeyVisible ? "text" : "password"} value={apiKey} onChange={event => setApiKey(event.target.value)} placeholder={settings?.configured ? settings.maskedApiKey : "Paste your Vercel AI Gateway key"} autoComplete="off"/><button type="button" onClick={() => void reveal()} disabled={busy || !settings?.configured} aria-label={apiKeyVisible ? "Hide API key" : "Reveal API key"}>{apiKeyVisible ? "◉" : "◌"}</button></div></label></section>
    {error && <p className="agents-error">{error}</p>}<footer><button type="button" className="modal-secondary" onClick={onClose}>Close</button><button className="modal-primary" disabled={busy || !apiKey.trim()}>{busy ? "Saving…" : "Save settings"}</button></footer>
  </form></div>;
}
createRoot(document.getElementById("root")!).render(<BrowserRouter><Routes><Route path="/" element={<ProjectsHome/>}/><Route path="/skills" element={<Shell><SkillsPage/></Shell>}/><Route path="/projects/:id" element={<ProjectWorkspaceRoute/>}/><Route path="/projects/:id/git" element={<Shell><IdePage/></Shell>}/><Route path="/projects/:id/ide" element={<Shell><IdePage/></Shell>}/><Route path="/projects/:id/diff" element={<Shell><IdePage/></Shell>}/><Route path="/projects/:id/console" element={<ConsolePage/>}/><Route path="/projects/:id/console/:jobId" element={<ConsolePage/>}/><Route path="*" element={<ProjectsHome/>}/></Routes></BrowserRouter>);
