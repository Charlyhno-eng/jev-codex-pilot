type Props = {
  hasDrafts: boolean;
  pendingCount: number;
  executionBlocked: boolean;
  creationBlocked?: boolean;
  submitting: boolean;
  launching: boolean;
};

/** Submits new drafts or launches saved pending tickets when the composer is empty. */
export function QueueSubmitButton({ hasDrafts, pendingCount, executionBlocked, creationBlocked = false, submitting, launching }: Props) {
  const disabled = submitting || launching || (hasDrafts ? creationBlocked : pendingCount === 0 || executionBlocked);
  const label = submitting ? "Evaluating…" : launching ? "Starting…" : hasDrafts || pendingCount === 0 ? "Add & evaluate" : executionBlocked ? "Queue paused or busy" : `Run ${pendingCount} task${pendingCount === 1 ? "" : "s"}`;
  return <button type="submit" className="analyze-button" disabled={disabled}>{label}<span>→</span></button>;
}
