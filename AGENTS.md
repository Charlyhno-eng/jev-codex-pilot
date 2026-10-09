# JEV Codex Pilot

JEV Codex Pilot turns software requests into traceable Codex tickets. The API lives in `src/api`, the ticket engine in `src/core`, and the web app in `src/web`. The project also includes a headless `jc-pilot` CLI documented in the README.

JEV scores and routes tickets by complexity, keeps project history in `.jev/`, and lets Codex choose and run task checks. It preserves related work in a Codex thread, clears unrelated work, compacts long context at 100,000 tokens, and stops repeated failed actions when the project has not changed. The headless CLI runs tickets through the same engine, one command at a time in queue order.

Do not change target project code or run its tests as part of JEV. Create or edit a target project's `AGENTS.md` only through the user flow, and run Codex only after an explicit API or Run action. Never expose secrets in code, logs, documentation, or the UI. Keep project instructions short and task focused, and record durable product behavior in `README.md`.

Give every exported function a concise adjacent JSDoc comment explaining its purpose. Record each delivered change in this file as a concise English paragraph. Earlier delivery notes are archived in `docs/agents-history.md`.

This update documents the project overview and replaces the README's CLI loop example with sequential commands joined by `&&`.

This update replaces advisory context review with Jev-scored tool-pair compaction. Pre-compaction processing now preserves user and assistant text, classifies paired calls and results as `keep`, `drop_result`, or `drop_call`, stores a redacted private checkpoint, and restores missing critical context through Codex's post-compaction `SessionStart` lifecycle.

This update adds an interactive Codex-style terminal workspace to `jc-pilot`. Users can compose multiple tickets, enter multiline requests, review or edit the pending session list, and run the batch in queue order. The existing headless `run` and `status` commands remain available, and the README documents the new flow.

This update gives the interactive terminal workspace colored project, queue, and next-action panels with opaque backgrounds for readability. All terminal prompts and messages are in English, and the README now shows the target-project launch command explicitly.

This update simplifies the README terminal section to the one-time setup command and the command that opens the interactive interface from a target project.

This update expands the web Git workspace with branch creation and selection, recent commit diffs, and an optional per-project commit and push after each successful ticket. JEV preserves the selected branch, uses Codex's suggested commit subject, and stops a ticket sequence when Git delivery fails.

This update fixes quota-resume and native Codex hook assertions, removes no-longer-used Git review UI code and a duplicate CI type-check, and makes TypeScript fail on unused local declarations and parameters. CI now uses Ubuntu 24.04 to avoid the upcoming ubuntu-latest image migration.

This update makes pending model and reasoning controls span all configured levels, changes per-ticket Git automation to create local commits only, and adds a manual push action for the selected branch.

This update gives the task composer a compact action row and shows the six Kanban states in a responsive three-column layout. It also aligns the Git controls with the application's blue theme and confirms a successful manual push with its branch and remote.

This update coordinates Codex execution fairly across project queues, letting another project run after each ticket instead of waiting for a whole batch or overlapping Codex processes. The web workspace also resets its ticket selection when switching projects, so Run cannot target a ticket from the previous project.

This update replaces the shared Codex execution slot with truly parallel project runs. Each project now has a private Codex home and SQLite state, while existing authentication and settings are linked and prior project sessions are imported for continuity; thread resume, compaction, and archival use the same private home.

This update routes complexity levels 1–2 to GPT-6 Luna Medium/High and levels 3–5 to GPT-6.1 Sol Low/Medium/High, aligning configuration, fallback models, failure escalation, and documentation.

This update fixes the saved-ticket migration test to expect Sol Medium for complexity level 4 under the new routing policy.

This update fixes image argument parsing by separating Codex options from positional prompts and session IDs, allows automatic Git tickets to start with uncommitted local changes, and enforces Conventional Commit subjects with a chore fallback. Existing local changes are included in the next successful ticket commit.

This update limits Git workspace review to all unpushed commits, clears stale commit selections after a push or refresh, and explains the empty state. Branches without upstream tracking use a matching remote branch or exclude commits already on known remote branches.

This update removes the private messaging integration, its configuration, completion notifications, interface controls, and dedicated tests. Provider settings and ticket execution remain available through the web app and CLI.

This update swaps the Done and Escalating Kanban columns and simplifies draft controls by removing the ready button and placing removal below the right-aligned reorder arrows.

This update adds distinct Kanban alerts for completed, failed, and escalated tickets, with louder multi-note audio signals, browser interaction audio activation, dismissible ticket descriptions, and project-scoped transition tracking.

This update adds a persisted per-project Human in the loop option that pauses after each ticket for explicit approval, provides Continue and final approval actions, and exposes pending-ticket re-evaluation alongside existing model and reasoning level adjustments. Automatic batch behavior remains unchanged when the option is disabled.

This update adds visible return-to-Pending actions for completed and failed tickets, hides Project files from the web workspace, and reduces the height of the Human in the loop project settings panel.

This update removes the Project settings heading and replaces return-to-Pending buttons with mouse drag and drop using native data transfer, draggable card containers, and highlights restricted to eligible destination columns.

This update enables mouse drag and drop to reorder Pending tickets with insertion markers, persists project-wide queue positions across batches and reloads, and uses the same order for the board and ticket execution without launching Codex when tickets are rearranged.

This update stretches the four sidebar controls to match the task composer height on desktop and allows Human in the loop to be changed during execution, applying the current setting when each ticket finishes.

This update resumes interrupted model escalations as Running tickets on the next explicit launch, preserves the selected route and partial-work thread across recovery and reload, and verifies that legacy recovery notices and earlier attempt errors do not block queue continuation.

This update keeps pending tickets running after automatic Git delivery or ticket startup failures, preserves visible error history and explicit human-review and session-limit pauses, and verifies queue continuation after related-thread compaction.

This update replaces the sidebar Git entry with an IDE & Git workspace containing a read-only source explorer and the existing Git tools in separate tabs. Explicitly opened project terminals use a local POSIX shell through Python 3, retain bounded in-memory output across navigation, support command interruption and local application links, and close on project removal or API shutdown. File access excludes common credentials and refuses external paths, while terminal routes require a local browser origin.

This update collapses IDE folders by default and refreshes the browser terminal with a clearer session header, status badge, styled actions, prompt input, keyboard shortcut hints, and application-link chips.

This update replaces the ticket summary validation field with cumulative estimated JEV credits, tracking evaluation, re-evaluation, continuity reviews, and native implementation and compaction hooks per ticket across retries and resumes. Private token-only telemetry stays beside the queue and incomplete historical usage is clearly identified.

This update reserves complexity level 1 for reading or explaining documentation, project information, or code and limited README.md or AGENTS.md edits. Running tests, installation commands, implementation work, and tiny cosmetic-only visual tweaks start at level 2; all UI/UX changes start at level 3.

This update reduces parallel-run web overhead with lightweight ticket summaries, status-only favicon requests, selected-ticket console logs, and sequential polling that skips unchanged responses and slows hidden workspaces while preserving ticket alerts. Live Codex telemetry writes are grouped over 250 ms while ticket transitions remain immediately durable, and controlled API shutdown flushes pending telemetry. Local config/config.toml is ignored by Git and automatically initialized with empty credentials without replacing existing settings.

This update adds an empty panel to the project task workspace, closed by default and opened almost full-screen with a small right-edge arrow. The panel supports arrow, Escape, and backdrop dismissal, and the navigation bar is slimmer on desktop and mobile.

This update moves the empty workspace panel to the left with subtle opening and closing animations and reduced-motion support. Project, IDE & Git, setup, and console pages share a redesigned header that places the back arrow beside the page identity and groups optional status details responsively. The Git tab replaces its duplicate page heading with a status toolbar.

This update fixes the project controls at the ticket composer's initial desktop height so additional drafts and growing descriptions no longer stretch the buttons. Project and IDE & Git pages adopt the console's 1,500-pixel content width, and the navigation bar continues the application background with a separating border.

This update redesigns the web workspace around four columns with ticket creation and image attachments in To do, a left read-only file explorer, and toolbar access to Git, application context, human review, and the Codex console. Escalations retain violet ticket outlines and paused sessions appear in Failed with amber outlines while execution statuses remain unchanged. Git becomes a dedicated page, the empty drawer and browser terminal are removed from the interface, and project, Git, and console pages expand to the available width.

This update organizes draft ticket actions in a dedicated footer with image attachment on the left and horizontal reorder and removal controls on the right. Application context moves directly after Board, Git status and refresh move into the shared page header, and source dialogs render through a document-level portal so ticket controls cannot overlap the viewer.

This update adds an application-wide skill library beside Codex console, portable SKILL.md and folder imports, and up to three independently selected skills per ticket. Frozen instructions and resources survive reloads, retries, thread resumes, and library removal without installing skills into target projects. Six built-in skills cover web, PySide6/QML, and GPUI interface design plus React, Python, and Rust performance and code simplification; import validation and credential-masked previews protect the shared library.

This update displays five skill cards per desktop row and opens instructions in an accessible popup with source and license metadata. It replaces the six JEV-authored built-ins with eleven Internet-sourced design, performance, and architecture skills, bundles retrieved reference resources with attribution and local content hashes, and preserves existing ticket snapshots.

This update displays cached, filename-based project language badges on project cards and workspace headers without reading source contents or running target commands. It adds a user-guided README writing skill and Documentation library filter, with verified assets and commands, a concise English description, and a final Quickstart.

This update adds a low-level Rust performance skill covering measured hotspots, SIMD, architecture intrinsics, and inline assembly with portable fallbacks and safety invariants. An orange usage note appears throughout skill browsing and selection, and frozen ticket copies retain the guidance across reloads without adding an approval step.

This update unifies popup close controls with the AGENTS.md dialog, prevents narrow source-viewer buttons, compacts workspace headers by placing language badges beside the title, and reduces the Git unpushed-commit empty-state text.

This update removes the paired benchmark runner, scenarios, reports, local benchmark archives, and benchmark-only telemetry. The README presents JEV as a complete ticket workflow covering planning, Codex execution, human review, Git delivery, and recovery while preserving operational ticket usage tracking.

This update adds a persisted, disabled-by-default Linter before push project checkbox matching Human in the loop. Only explicit manual Push launches isolated Codex lint corrections and post-edit regression checks for JavaScript/TypeScript, Python, Rust, and Go; successful verified local changes are committed before pushing, failures block the push, and the project execution slot prevents concurrent Git or ticket actions. Automatic ticket commits remain unchanged and JEV never runs target linters or tests itself.

This update strengthens pre-push verification with explicit per-language tool coverage, separate formatter and linter checks for Python, Rust, and Go, and successful Codex command-event evidence for every reported check. Mixed-language omissions, unexecuted commands, and checks preceding recorded file edits cannot approve a push; dedicated tests cover all supported source extensions and language/tool mappings.

This update corrects the README workspace overview to match the four visible board columns and six active ticket states.

This update separates top navigation sections with accessible pipe marks, adds ESLint and React Hooks checks to local scripts and CI, fixes existing lint violations, and lets explicit pre-push verification configure missing project lint tools before running checks.

This update moves default linter setup into visible project preparation tickets at registration, reopening, and explicit execution, preserves existing tools, and initializes newly introduced languages during ticket work. Manual pushes only share existing commits, the pre-push Codex gate and checkbox are removed, and separate Git activity with automatic workspace refresh prevents completed tickets from being mislabeled as active during a push.

This update distinguishes successful branch pushes from branches already up to date using Git porcelain output, so the Git workspace reports when there is nothing to push even with uncommitted local changes.

This update gives already-up-to-date push notices a violet information icon and panel, visually distinguishing them from successful push confirmations.
