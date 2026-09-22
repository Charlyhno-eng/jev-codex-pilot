# JEV Codex Pilot

## Project boundaries

- API code lives in `src/api`, JEV in `src/core`, and the web interface in `src/web`.
- JEV is read-only for target projects and never runs their tests.
- Codex runs only after an explicit action through the API or the Run button.
- Preserve project data and history under `.jev/`.
- Never expose API keys or other secrets in source code, logs, documentation, or UI output.

## Current behavior

- Projects have separate context, queues, histories, and Codex threads.
- The web interface can create and edit a project `AGENTS.md` through a modal.
- JEV evaluates each ticket, reports precision and task breakdown, and recommends a model tier and reasoning effort.
- Codex can route successive turns dynamically: verification favors low effort, while failed checks can use a stronger repair route. Each route is logged in red by JEV.
- JEV selects the files Codex should inspect first and reviews the actual changed files before approving targeted tests.
- Each ticket records a planning token estimate, Codex-reported token total, executed turns, repair count, and model routes. A successful validation stops further repair turns.
- Compatible pending tickets may share one execution when their model and reasoning settings are close enough.
- Live JSONL events, commands, verification, model routing, and token usage are streamed to the UI.
- Successful work triggers automatic thread compaction after every third successful task or when the measured context reaches 90,000 tokens. Compaction failure does not fail the task.
- Telegram is optional, private-chat-only, and sends a completion summary after development runs.
- Vercel AI Gateway is currently the only supported analysis provider; its configuration stays in `config/config.toml`.

## Recent delivery

This project now includes modular web components and styles, dedicated tests, English backend docstrings, red JEV logs, distinct Codex command and routing colors, Git status detection, modal first-time `AGENTS.md` creation, read-only Git review, Telegram progress and completion notices, dynamic model and effort routing, and consistent ticket precision between analysis and execution.

- Rewrote the English README with honest token-saving estimates, provider extensibility guidance, and a shorter Telegram section.
- Added early validation stops and per-ticket execution economy metrics.
- Distinguished missing verification dependencies from code failures and escalated persistent repairs to Sol.
- Set persistent repair escalation to Sol High and adopted the refreshed application logo.
- Updated the dark web theme with blue, cyan, and violet colors taken from the refreshed logo.
- Added browser-tab favicon indicators for running, completed, and failed tickets.
- Added persistent session-limit pausing with automatic Codex rate-limit reset detection and resumption.
- Linked Git availability notices to their status card, softened JEV terminal logs, and calibrated token estimates from project history.
- Kept the ticket model through verification and first repair, reserved Sol High for a repeated failed check, and recorded accurate per-turn cache and token usage.
- Added end-of-ticket Codex context-window, five-hour, and weekly-limit snapshots to the execution view.
- Removed unused file-change predictions and navbar session usage, and simplified task precision to lenient 20-point bands.
- Stopped repair loops on missing build dependencies and added a persistent English verification note to completed tickets.
- Added JEV-approved tests scoped to actual ticket changes, tighter Codex file guidance, and context-triggered compaction at 90,000 tokens.
- Reframed the project documentation around workflow optimization, traceability, adaptive execution, and reliable recovery, with token savings presented as a measured secondary benefit.
- Logged every file selected for Codex context in orange, changed the completed queue label to Done, and made Telegram open only after `/start`.
- Rebuilt the console around per-ticket JEV activity, model routes, commands, verification, and development completion instead of duplicated execution panels.
- Added validated atomic snapshots and automatic backups for local JEV state, plus atomic attachment writes.
- Added a single API instance lock, per-project execution locks, Codex heartbeats, stalled-process recovery, and a single Telegram poller lock.
- Classified ticket issues by source and kept completed work out of Failed when verification dependencies are missing.

Keep future delivery notes concise and append one English bullet here for each completed feature or change.
