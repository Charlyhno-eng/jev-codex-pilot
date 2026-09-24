export type Complexity = 1 | 2 | 3 | 4 | 5;
export type CodexModel = string;
export type Reasoning = string;
export type JobStatus = "PENDING" | "RUNNING" | "ESCALATING" | "SESSION_PAUSED" | "SUCCESS" | "FAILED" | "SKIPPED";
export type JobIssueCategory = "code" | "verification" | "dependency" | "codex" | "loop" | "quota" | "interruption" | "telegram" | "jev";
export type TaskType = "installation" | "feature" | "bugfix" | "ui_ux" | "refactoring" | "testing" | "documentation" | "configuration" | "architecture" | "performance" | "security" | "database" | "research";

export interface TaskSpec {
  description: string;
}

/** A local visual reference attached to one independently analysed ticket. */
export interface JobAttachment {
  id: string;
  name: string;
  mimeType: string;
  /** Private local path used only when JEV starts Codex with --image. */
  path: string;
  size: number;
}
export type ExecutionPhase = "QUEUED" | "STARTING" | "THINKING" | "WORKING" | "FINISHING" | "COMPLETED" | "ERROR";

export interface ExecutionEvent {
  id: string;
  timestamp: string;
  kind: "system" | "reasoning" | "command" | "file" | "message" | "error";
  title: string;
  detail?: string;
  status?: "active" | "success" | "error";
}

export interface ExecutionState {
  phase: ExecutionPhase;
  model: string;
  reasoning: Reasoning;
  startedAt: string;
  lastActivityAt: string;
  heartbeatAt?: string;
  completedAt?: string;
  pid?: number;
  threadId?: string;
  /** The rollout was archived after JEV found the next ticket unrelated. */
  threadArchivedAt?: string;
  /** The thread must not be resumed after its automatic archive failed. */
  threadResumeDisabledAt?: string;
  /** The ticket is progressing through JEV's automatic model escalation ladder. */
  escalationPending?: boolean;
  /** Whether any attempt in this escalation chain changed project files. */
  projectChangesDetected?: boolean;
  /** The continuity decision already made for the next queued ticket. */
  reviewedNextTaskId?: string;
  reviewedNextContinuity?: "related" | "unrelated" | "uncertain";
  usage?: CodexUsage;
  /** A best-effort account-wide usage snapshot captured from Codex app-server. */
  accountUsage?: CodexAccountUsage;
  codexStatus?: CodexStatusSnapshot;
  /** Planning and reported usage metrics for this Codex execution. */
  metrics?: CodexExecutionMetrics;
  compactedAfterTask?: boolean;
  verification: "not_run" | "build_only" | "tests_passed" | "functional_verified" | "environment_blocked";
  verificationNote?: string;
  events: ExecutionEvent[];
}

export interface CodexUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
}

export interface CodexExecutionMetrics {
  estimatedTokens: number;
  estimateBasis?: "scope" | "project_history";
  actualTokens?: number;
  turns: number;
  routes: Array<{ stage: "implementation"; model: string; reasoning: Reasoning; usage?: CodexUsage }>;
}

export interface CodexAccountUsage {
  capturedAt: string;
  lifetimeTokens?: number;
  peakDailyTokens?: number;
  todayTokens?: number;
  unavailableReason?: string;
}

export interface CodexStatusWindow {
  remainingPercent: number;
  resetsAt?: string;
}

export interface CodexStatusSnapshot {
  capturedAt: string;
  context?: { usedTokens: number; windowTokens: number };
  fiveHour?: CodexStatusWindow;
  weekly?: CodexStatusWindow;
  unavailableReason?: string;
}

export interface JevAnalysis {
  complexity: Complexity;
  /** Advisory score for how clearly the ticket describes its expected result. */
  outcome_clarity_score?: number;
  task_types: string[];
  model: CodexModel;
  reasoning: Reasoning;
  /** Legacy fields retained when reading older ticket history. */
  context_files?: string[];
  files_to_modify?: string[];
  rationale: string[];
  evaluator: "typesafe-ai/jev";
  evaluation_usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    /** Local estimate from the published JEV input-token rate. */
    estimated_cost_usd?: number;
  };
}

export interface Job {
  id: string;
  projectId: string;
  batchId?: string;
  order?: number;
  projectPath: string;
  tasks: TaskSpec[];
  attachments?: JobAttachment[];
  status: JobStatus;
  analysis?: JevAnalysis;
  createdAt: string;
  updatedAt: string;
  output?: string;
  error?: string;
  errorCategory?: JobIssueCategory;
  recoveryNote?: string;
  notificationError?: string;
  /** Next known Codex quota reset for work paused by a reached session limit. */
  sessionResumeAt?: string;
  attempts: number;
  /** Archived tasks stay in history but are hidden from the active board. */
  archivedAt?: string;
  execution?: ExecutionState;
}

export interface ProjectRecord {
  id: string;
  name: string;
  path: string;
  /** True only when JEV created the project's initial AGENTS.md file. */
  agentsCreatedByJev?: boolean;
  /** Hidden from the JEV workspace list, but retained locally so history can be restored by re-adding the same folder. */
  removedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectFile { path: string; size: number; }
