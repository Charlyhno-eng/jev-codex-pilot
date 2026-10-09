import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { WorkspaceHeader } from "./WorkspaceHeader.js";
import { api } from "../lib/api.js";
import type { GitWorkspace, ProjectDiff, ProjectRecord } from "../lib/types.js";

/** Shows branch controls, automatic delivery, history, and file diffs for a project. */
export function GitPage() {
  const { id = "" } = useParams();
  const [project, setProject] = useState<ProjectRecord>();
  const [git, setGit] = useState<GitWorkspace>();
  const [diff, setDiff] = useState<ProjectDiff>();
  const [selectedCommit, setSelectedCommit] = useState("");
  const [selectedPath, setSelectedPath] = useState("");
  const [branchName, setBranchName] = useState("");
  const [busy, setBusy] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [pushNotice, setPushNotice] = useState("");
  const [pushUpToDate, setPushUpToDate] = useState(false);
  const load = useCallback(async (commit: string) => {
    const [record, state, requestedChanges] = await Promise.all([
      api<ProjectRecord>(`/projects/${id}`), api<GitWorkspace>(`/projects/${id}/git`),
      api<ProjectDiff>(`/projects/${id}/diff${commit ? `?commit=${encodeURIComponent(commit)}` : ""}`)
    ]);
    let changes = requestedChanges;
    if (commit && !state.commits.some(entry => entry.hash === commit)) {
      changes = await api<ProjectDiff>(`/projects/${id}/diff`);
      commit = "";
    }
    setSelectedCommit(commit);
    setProject(record); setGit(state); setDiff(changes);
    setRunning(Boolean(state.busy));
    setSelectedPath(path => changes.files.some(file => file.path === path) ? path : changes.files[0]?.path ?? "");
    setError("");
  }, [id]);
  useEffect(() => { void load("").catch(reason => setError(reason instanceof Error ? reason.message : String(reason))); }, [load]);
  useEffect(() => {
    if (!running || busy) return;
    const timer = setTimeout(() => { void load(selectedCommit).catch(reason => setError(reason instanceof Error ? reason.message : String(reason))); }, 2_000);
    return () => clearTimeout(timer);
  }, [running, busy, load, selectedCommit, git]);
  const changeCommit = async (commit: string) => { setSelectedCommit(commit); try { await load(commit); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } };
  const branchAction = async (name: string, create: boolean) => {
    setBusy(true); setError(""); setPushNotice("");
    try { await api<GitWorkspace>(`/projects/${id}/git/branch`, { method: "POST", body: JSON.stringify({ name, create }) }); setSelectedCommit(""); setBranchName(""); await load(""); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };
  const toggleAuto = async (enabled: boolean) => {
    setBusy(true); setError("");
    try { setProject(await api<ProjectRecord>(`/projects/${id}/git/settings`, { method: "PUT", body: JSON.stringify({ autoCommitPush: enabled }) })); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };
  const pushBranch = async () => {
    setBusy(true); setPushing(true); setError(""); setPushNotice("");
    try { const pushed = await api<GitWorkspace & { pushStatus: "pushed" | "up_to_date" }>(`/projects/${id}/git/push`, { method: "POST" }); setPushUpToDate(pushed.pushStatus === "up_to_date"); setPushNotice(pushed.pushStatus === "up_to_date" ? `${pushed.branch} is already up to date on ${pushed.remote}. Nothing to push.` : `Pushed ${pushed.branch} to ${pushed.remote}.`); setSelectedCommit(""); await load(""); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); setPushing(false); }
  };
  const selected = diff?.files.find(file => file.path === selectedPath);
  return <main className="workspace-main git-workspace-page"><WorkspaceHeader backTo={`/projects/${id}`} backLabel="Project workspace" eyebrow="PROJECT WORKSPACE" title="Git" description={project?.name ?? "Branches, local commits, and unpushed changes"}>
    <div aria-label="Git workspace status"><div className="project-overview"><span><b>{git?.branch ?? "—"}</b>CURRENT BRANCH</span><span><b>{diff?.files.length ?? 0}</b>CHANGED FILES</span><button className="refresh-diff" type="button" onClick={() => void load(selectedCommit).catch(reason => setError(String(reason)))}>Refresh</button></div></div></WorkspaceHeader>
    <section className="diff-main git-page">
    {error && <div className="alert"><b>Git needs attention</b><span>{error}</span></div>}
    {git && <><section className="git-control-grid"><article className="git-control-card"><div className="git-card-heading"><span className="eyebrow">CURRENT BRANCH</span><strong>{git.branch}</strong><small>{git.upstream ? `Tracking ${git.upstream}` : git.remote ? `Push remote: ${git.remote}` : "No push remote configured"}</small></div><div className="git-branch-fields"><label>Switch to a local branch<select value={git.branch} disabled={busy || running || git.dirty} onChange={event => void branchAction(event.target.value, false)}>{git.branches.map(name => <option key={name} value={name}>{name}</option>)}</select></label><form onSubmit={event => { event.preventDefault(); void branchAction(branchName.trim(), true); }}><label>Create and switch to a branch<input value={branchName} onChange={event => setBranchName(event.target.value)} placeholder="feature/my-change" disabled={busy || running || git.dirty}/></label><button type="submit" disabled={busy || running || git.dirty || !branchName.trim()}>Create branch</button></form>{git.dirty && <p className="git-hint">Review or commit local changes before switching branches.</p>}</div></article>
    <article className="git-control-card"><div className="git-card-heading"><span className="eyebrow">TICKET DELIVERY</span><strong>Commits &amp; push</strong><small>Set how finished tickets are saved and shared</small></div><div className="git-delivery-settings"><label className="git-auto-toggle"><input type="checkbox" checked={Boolean(project?.autoCommitPush)} disabled={busy || running} onChange={event => void toggleAuto(event.target.checked)}/><span><b>Automatic local commits</b><small>Commit after each successful ticket</small></span></label><p>Codex suggests the message. JEV commits on <b>{git.branch}</b> before the next ticket starts.</p><p className="git-hint">Existing local changes are included in the next automatic commit.</p></div><div className="git-push-panel"><div><span className="eyebrow">MANUAL PUSH</span><strong>Share this branch</strong><small>{git.remote ? `${git.branch} → ${git.remote}` : "Configure a remote to push this branch."}</small></div><button type="button" onClick={() => void pushBranch()} disabled={busy || running || !git.remote}>{pushing ? "Pushing…" : "Push current branch"}<span aria-hidden="true">↗</span></button>{pushNotice && <p className={`git-push-success${pushUpToDate ? " git-push-info" : ""}`} role="status"><span aria-hidden="true">{pushUpToDate ? "i" : "✓"}</span>{pushNotice}</p>}</div></article></section>
    <section className="git-review"><aside className="git-history"><header><b>REVIEW</b><small>UNPUSHED COMMITS</small></header><button className={!selectedCommit ? "active" : ""} onClick={() => void changeCommit("")}><b>Working tree</b><small>{git.dirty ? "Uncommitted changes" : "No local changes"}</small></button>{git.commits.map(commit => <button key={commit.hash} className={selectedCommit === commit.hash ? "active" : ""} onClick={() => void changeCommit(commit.hash)}><b>{commit.subject}</b><small>{commit.hash} · {new Date(commit.date).toLocaleDateString()} · {commit.author}</small></button>)}{!git.commits.length && <p className="git-hint">No commits waiting to be pushed.</p>}</aside><div className="git-review-body"><div className="git-review-title"><div><span className="eyebrow">{selectedCommit ? `COMMIT ${selectedCommit}` : "WORKING TREE"}</span><h2>{selectedCommit ? git.commits.find(commit => commit.hash === selectedCommit)?.subject : "Local changes"}</h2><p>{selectedCommit ? "Files changed in this commit" : "Changes since the latest commit"}</p></div><b>{diff?.files.length ?? 0} files</b></div><section className="diff-workbench"><aside className="diff-files"><header><b>FILES</b><small>{diff?.base}</small></header>{diff?.files.length ? <div className="diff-tree"><details open><summary>CHANGED FILES</summary>{diff.files.map(file => <button type="button" key={file.path} className={file.path === selectedPath ? "active" : ""} onClick={() => setSelectedPath(file.path)}><i className={file.status}/><span>{file.path}</span><small>{file.status}</small></button>)}</details></div> : <p>No files changed in this view.</p>}</aside><article className="diff-view">{selected ? <><header><span className={`diff-status ${selected.status}`}>{selected.status}</span><b>{selected.path}</b></header><pre>{selected.diff.split("\n").map((line, index) => <code className={line.startsWith("+") && !line.startsWith("+++") ? "addition" : line.startsWith("-") && !line.startsWith("---") ? "deletion" : line.startsWith("@@") ? "hunk" : line.startsWith("diff ") || line.startsWith("+++") || line.startsWith("---") ? "meta" : ""} key={`${index}-${line}`}>{String(index + 1).padStart(4, " ")} {line || " "}{"\n"}</code>)}</pre></> : <div className="diff-empty">{diff?.files.length ? "Select a file to review its diff." : "No changes to display."}</div>}</article></section></div></section></>}
  </section></main>;
}
