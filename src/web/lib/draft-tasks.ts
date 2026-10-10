import type { DraftTask } from "./types.js";

/** Keeps unsent drafts and edits made while submitted tickets are being saved. */
export function remainingDraftTasks(current: DraftTask[], submitted: DraftTask[]): DraftTask[] {
  return current.filter(task => !submitted.some(saved => saved.id === task.id && saved.description === task.description && saved.attachments === task.attachments && saved.skills === task.skills));
}
