import { memo, useRef, useState } from "react";
import { readDraftImage } from "../lib/draft-images.js";
import { scheduleTextareaResize } from "../lib/textarea-resize.js";
import { remainingDraftTasks } from "../lib/draft-tasks.js";
import type { DraftAttachment, DraftTask } from "../lib/types.js";
import { QueueSubmitButton } from "./QueueSubmitButton.js";
import { SkillPicker } from "./Skills.js";

export type SubmittedTask = {
  description: string;
  skillIds?: string[];
  attachments?: Array<Pick<DraftAttachment, "name" | "mimeType" | "base64">>;
};

type Props = {
  pendingCount: number;
  executionBlocked: boolean;
  launching: boolean;
  externalError: string;
  onCreate: (tasks: SubmittedTask[]) => Promise<void>;
  onRun: () => Promise<void>;
};

function makeTask(): DraftTask { return { id: crypto.randomUUID(), description: "", attachments: [] }; }

/** Keeps draft typing local to the composer while preserving queue execution and attachments. */
export const TaskComposer = memo(function TaskComposer({ pendingCount, executionBlocked, launching, externalError, onCreate, onRun }: Props) {
  const [tasks, setTasks] = useState<DraftTask[]>(() => [makeTask()]);
  const [dragged, setDragged] = useState<number>();
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const imageRead = useRef(false);
  const [loadingImages, setLoadingImages] = useState(false);
  const moveTask = (from: number, to: number) => setTasks(items => { if (to < 0 || to >= items.length) return items; const copy = [...items]; const [item] = copy.splice(from, 1); copy.splice(to, 0, item); return copy; });
  const addImages = async (taskId: string, files: FileList | null) => { const additions = Array.from(files ?? []); if (!additions.length || submitting || imageRead.current) return; if (additions.some(file => !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.type))) { setError("Only PNG, JPEG, GIF, and WebP images can be attached."); return; } if (additions.some(file => file.size > 5 * 1024 * 1024)) { setError("Each attached image must be 5 MB or smaller."); return; } const current = tasks.find(task => task.id === taskId); if ((current?.attachments?.length ?? 0) + additions.length > 4) { setError("Attach at most four images to one task."); return; } imageRead.current = true; setLoadingImages(true); try { const images = await Promise.all(additions.map(readDraftImage)); setTasks(items => items.map(item => item.id === taskId ? { ...item, attachments: [...(item.attachments ?? []), ...images] } : item)); setError(""); } catch { setError("The selected image could not be read."); } finally { imageRead.current = false; setLoadingImages(false); } };
  const validateTask = (task: DraftTask) => {
    if (!task.description.trim()) return;
    setTasks(items => items.map(item => item.id === task.id ? { ...item, confirmed: !item.confirmed } : item));
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitting || launching || imageRead.current) return;
    const submitted = tasks.filter(task => task.description.trim());
    const clean = submitted.map(task => ({
      description: task.description.trim(),
      skillIds: task.skills?.map(skill => skill.id),
      attachments: task.attachments?.map(({ name, mimeType, base64 }) => ({ name, mimeType, base64 }))
    }));
    setError("");
    if (!clean.length) { await onRun(); return; }
    setSubmitting(true);
    try { await onCreate(clean); setTasks(current => { const remaining = remainingDraftTasks(current, submitted); return remaining.length ? remaining : [makeTask()]; }); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setSubmitting(false); }
  };
  return (
      <form className="setup-card todo-composer" aria-label="Create To do tickets" onSubmit={submit}>
        <div className="task-list">{tasks.map((task, index) => <div className={`task-row ${dragged === index ? "dragging" : ""} ${task.confirmed ? "confirmed" : ""}`} key={task.id} onDragOver={event => event.preventDefault()} onDrop={() => { if (dragged !== undefined) moveTask(dragged, index); }}>
          <span className="drag-handle" draggable onDragStart={event => { event.dataTransfer.effectAllowed = "move"; setDragged(index); }} onDragEnd={() => setDragged(undefined)} title="Drag to reorder">⠿</span>
          <span className="task-number">{String(index + 1).padStart(2, "0")}</span>
          <div className="task-body">
            <textarea aria-label={`Ticket ${index + 1} description`} rows={2} value={task.description} onInput={event => scheduleTextareaResize(event.currentTarget)} onKeyDown={event => { if (event.ctrlKey && event.key === "Enter") { event.preventDefault(); validateTask(task); } }} onChange={event => { const description = event.currentTarget.value; setTasks(items => items.map(item => item.id === task.id ? { ...item, description, confirmed: false } : item)); }} placeholder="Describe one concrete outcome…"/>
            {Boolean(task.attachments?.length) && <div className="draft-task-meta">
              {task.attachments?.map(image => <figure className="draft-image" key={image.id}><img src={image.previewUrl} alt="Task visual reference"/><figcaption>{image.name}</figcaption><button type="button" onClick={() => setTasks(items => items.map(item => item.id === task.id ? { ...item, attachments: item.attachments?.filter(candidate => candidate.id !== image.id) } : item))} aria-label={`Remove ${image.name}`}>×</button></figure>)}
            </div>}
          </div>
          <div className="draft-task-footer"><div className="draft-reference-actions"><label className="draft-attach-image"><input type="file" disabled={submitting || loadingImages} accept="image/png,image/jpeg,image/gif,image/webp" multiple onChange={event => { void addImages(task.id, event.currentTarget.files); event.currentTarget.value = ""; }}/><span>＋ Add image</span></label><SkillPicker selected={task.skills ?? []} onChange={skills => setTasks(items => items.map(item => item.id === task.id ? { ...item, skills } : item))}/></div><div className="task-controls"><div className="task-move-controls"><button type="button" disabled={index === 0} onClick={() => moveTask(index, index - 1)} title="Move task up" aria-label={`Move draft ${index + 1} up`}>↑</button><button type="button" disabled={index === tasks.length - 1} onClick={() => moveTask(index, index + 1)} title="Move task down" aria-label={`Move draft ${index + 1} down`}>↓</button></div><button type="button" onClick={() => setTasks(items => items.length === 1 ? [makeTask()] : items.filter(item => item.id !== task.id))} title="Remove task" aria-label={`Remove draft ${index + 1}`}>×</button></div></div>
        </div>)}</div>
        {(error || externalError) && <div className="alert"><b>Something needs attention</b><span>{error || externalError}</span></div>}
        <div className="queue-compose-actions"><button className="add-task" type="button" onClick={() => setTasks(items => [...items, makeTask()])}><span>＋</span>Add task</button><QueueSubmitButton hasDrafts={tasks.some(task => Boolean(task.description.trim()))} pendingCount={pendingCount} executionBlocked={executionBlocked} submitting={submitting || loadingImages} launching={launching}/></div>
      </form>
  );
});
