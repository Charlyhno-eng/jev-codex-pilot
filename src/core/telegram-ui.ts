import type { Job, ProjectRecord } from "./types.js";

export type TelegramAction =
  | "home"
  | "projects"
  | "project"
  | "new"
  | "ticket"
  | "run-menu"
  | "run"
  | "clear"
  | "cancel"
  | "delete-request"
  | "delete-confirm"
  | "delete-cancel";

export type TelegramView =
  | "home"
  | "projects"
  | "project"
  | "new-project"
  | "run-project"
  | "compose"
  | "created"
  | "delete-confirm"
  | "notice";

export type TelegramButton = { text: string; action: TelegramAction; argument?: string };
export type TelegramScreen = { view: TelegramView; text: string; buttons: TelegramButton[][] };

export const allowedActions: Record<TelegramView, readonly TelegramAction[]> = {
  home: ["projects", "new", "run-menu", "clear"],
  projects: ["project", "home"],
  project: ["ticket", "run", "projects", "home"],
  "new-project": ["ticket", "home"],
  "run-project": ["run", "home"],
  compose: ["cancel"],
  created: ["delete-request", "project", "run", "home"],
  "delete-confirm": ["delete-confirm", "delete-cancel"],
  notice: ["home"]
};

const escape = (value: string) => value.replace(/[&<>]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[char]!);
const activeJobs = (jobs: Job[]) => jobs.filter(job => !job.archivedAt && job.status !== "SKIPPED");

/** Builds the Telegram dashboard with ticket counts. */
export function homeScreen(projects: ProjectRecord[], jobsFor: (projectId: string) => Job[], notice?: string): TelegramScreen {
  const jobs = projects.flatMap(project => activeJobs(jobsFor(project.id)));
  const pending = jobs.filter(job => job.status === "PENDING").length;
  const running = jobs.filter(job => job.status === "RUNNING").length;
  const headline = notice ? `${notice}\n\n` : "";
  return {
    view: "home",
    text: `${headline}✨ <b>JEV CODEX PILOT</b>\n<i>Your focused project cockpit.</i>\n\n🗂 <b>${projects.length}</b> project${projects.length === 1 ? "" : "s"}   ·   ⏳ <b>${pending}</b> pending   ·   ⚡ <b>${running}</b> running\n\nWhat would you like to do?`,
    buttons: [
      [{ text: "📊  Projects", action: "projects" }, { text: "➕  New ticket", action: "new" }],
      [{ text: `▶️  Launch Codex${pending ? ` · ${pending}` : ""}`, action: "run-menu" }],
      [{ text: "🧹  Reset this chat", action: "clear" }]
    ]
  };
}

function projectRows(projects: ProjectRecord[], action: "project" | "ticket" | "run", suffix?: (project: ProjectRecord) => string): TelegramButton[][] {
  return projects.map(project => [{ text: `${action === "run" ? "▶️" : action === "ticket" ? "➕" : "🗂"}  ${project.name}${suffix?.(project) ?? ""}`.slice(0, 60), action, argument: project.id }]);
}

/** Builds the Telegram project picker. */
export function projectsScreen(projects: ProjectRecord[]): TelegramScreen {
  return {
    view: "projects",
    text: projects.length ? "📊 <b>PROJECTS</b>\n<i>Select one to view its live progress.</i>" : "📊 <b>PROJECTS</b>\n\n<i>No project is configured yet. Add one from the web interface first.</i>",
    buttons: [...projectRows(projects, "project"), [{ text: "⌂  Dashboard", action: "home" }]]
  };
}

/** Builds the Telegram new-ticket project picker. */
export function newTicketProjectScreen(projects: ProjectRecord[]): TelegramScreen {
  return {
    view: "new-project",
    text: projects.length ? "➕ <b>NEW TICKET</b>\n<i>First, choose its project.</i>" : "➕ <b>NEW TICKET</b>\n\n<i>No project is available. Add one from the web interface first.</i>",
    buttons: [...projectRows(projects, "ticket"), [{ text: "⌂  Dashboard", action: "home" }]]
  };
}

/** Builds the Telegram runnable-project picker. */
export function runProjectScreen(projects: ProjectRecord[], pendingFor: (projectId: string) => Job[]): TelegramScreen {
  const runnable = projects.filter(project => pendingFor(project.id).length > 0);
  return {
    view: "run-project",
    text: runnable.length ? "▶️ <b>LAUNCH CODEX</b>\n<i>Only projects with pending tickets are available.</i>\n\nSelect the project to launch:" : "✅ <b>QUEUE CLEAR</b>\n\nThere are no pending tickets to launch.",
    buttons: [...projectRows(runnable, "run", project => `  ·  ${pendingFor(project.id).length}`), [{ text: "⌂  Dashboard", action: "home" }]]
  };
}

/** Builds a Telegram project status screen. */
export function projectScreen(project: ProjectRecord, jobs: Job[]): TelegramScreen {
  const visible = activeJobs(jobs);
  const count = (status: Job["status"]) => visible.filter(job => job.status === status).length;
  const pending = count("PENDING");
  const running = visible.find(job => job.status === "RUNNING");
  const latest = [...visible].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  const activity = running
    ? `\n\n⚡ <b>Now running</b>\n${escape(running.tasks[0]?.description ?? "Current ticket")}\n<code>${running.execution?.phase ?? "RUNNING"}</code>`
    : latest
      ? `\n\n<b>Latest activity</b>\n${escape(latest.tasks[0]?.description ?? "Untitled ticket")}\n<code>${latest.status}</code>`
      : "\n\n<i>No tickets yet.</i>";
  const buttons: TelegramButton[][] = [[{ text: "➕  Create ticket", action: "ticket", argument: project.id }]];
  if (pending > 0) buttons.push([{ text: `▶️  Launch next · ${pending} pending`, action: "run", argument: project.id }]);
  buttons.push([{ text: "←  All projects", action: "projects" }, { text: "⌂  Dashboard", action: "home" }]);
  return {
    view: "project",
    text: `📊 <b>${escape(project.name).toUpperCase()}</b>\n\n⏳ Pending      <b>${pending}</b>\n⚡ Running      <b>${count("RUNNING")}</b>\n✅ Completed   <b>${count("SUCCESS")}</b>\n⚠️ Failed         <b>${count("FAILED")}</b>${activity}`,
    buttons
  };
}

/** Builds the Telegram ticket composition screen. */
export function composeTicketScreen(project: ProjectRecord, warning?: string): TelegramScreen {
  return {
    view: "compose",
    text: `✍️ <b>NEW TICKET</b>\n🗂 ${escape(project.name)}\n\n${warning ? `⚠️ <i>${escape(warning)}</i>\n\n` : ""}Send the ticket description in one text message. It will be added to the pending column.`,
    buttons: [[{ text: "✕  Cancel creation", action: "cancel" }]]
  };
}

/** Builds the Telegram created-ticket screen. */
export function createdTicketScreen(project: ProjectRecord, job: Job): TelegramScreen {
  return {
    view: "created",
    text: `✅ <b>TICKET CREATED</b>\n\n🗂 ${escape(project.name)}\n📝 ${escape(job.tasks[0]?.description ?? "")}\n\n<i>It is now waiting in the pending column.</i>`,
    buttons: [[{ text: "🗑  Delete this ticket", action: "delete-request", argument: job.id }], [{ text: "📊  View project", action: "project", argument: project.id }, { text: "⌂  Dashboard", action: "home" }]]
  };
}

/** Builds the Telegram ticket deletion confirmation. */
export function deleteConfirmationScreen(project: ProjectRecord, job: Job): TelegramScreen {
  return {
    view: "delete-confirm",
    text: `🗑 <b>DELETE THIS TICKET?</b>\n\n🗂 ${escape(project.name)}\n📝 ${escape(job.tasks[0]?.description ?? "")}\n\n⚠️ <i>This permanently removes the pending ticket.</i>`,
    buttons: [[{ text: "Delete permanently", action: "delete-confirm", argument: job.id }], [{ text: "←  Keep ticket", action: "delete-cancel", argument: job.id }]]
  };
}

/** Builds a Telegram notice screen. */
export function noticeScreen(title: string, detail: string): TelegramScreen {
  return { view: "notice", text: `${title}\n\n${detail}`, buttons: [[{ text: "⌂  Dashboard", action: "home" }]] };
}
