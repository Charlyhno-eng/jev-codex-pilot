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
- Compatible pending tickets may share one execution when their model and reasoning settings are close enough.
- Live JSONL events, commands, verification, model routing, and token usage are streamed to the UI.
- Successful work triggers automatic thread compaction after every third successful task. Compaction failure does not fail the task.
- Telegram is optional, private-chat-only, and sends a completion summary after development runs.
- Vercel AI Gateway is currently the only supported analysis provider; its configuration stays in `config/config.toml`.

## Recent delivery

This project now includes modular web components and styles, dedicated tests, English backend docstrings, red JEV logs, distinct Codex command and routing colors, Git status detection, modal first-time `AGENTS.md` creation, read-only Git review, Telegram progress and completion notices, dynamic model and effort routing, and consistent ticket precision between analysis and execution.

- Rewrote the English README with honest token-saving estimates, provider extensibility guidance, and a shorter Telegram section.

Keep future delivery notes concise and append one English bullet here for each completed feature or change.
