const pending = new WeakMap<HTMLTextAreaElement, number>();

/** Coalesces textarea height measurements into one update per animation frame. */
export function scheduleTextareaResize(textarea: HTMLTextAreaElement) {
  if (pending.has(textarea)) return;
  const frame = requestAnimationFrame(() => {
    pending.delete(textarea);
    if (!textarea.isConnected) return;
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
  });
  pending.set(textarea, frame);
}
