type Props = {
  hasDrafts: boolean;
  pendingCount: number;
  executionBlocked: boolean;
  submitting: boolean;
  launching: boolean;
};

/** Submits new drafts or launches saved pending tickets when the composer is empty. */
export function QueueSubmitButton({ hasDrafts, pendingCount, executionBlocked, submitting, launching }: Props) {
  const disabled = submitting || launching || (!hasDrafts && (pendingCount === 0 || executionBlocked));
  const label = submitting ? "Adding…" : launching ? "Starting…" : hasDrafts || pendingCount === 0 ? "Add & run" : executionBlocked ? "Queue paused or busy" : `Run ${pendingCount} task${pendingCount === 1 ? "" : "s"}`;
  return <button type="submit" className="analyze-button" disabled={disabled}>{label}<span>→</span></button>;
}
