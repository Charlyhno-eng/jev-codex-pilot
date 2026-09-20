![JEV Codex Pilot banner](assets/jev-codex-pilot-banner.png)

# JEV Codex Pilot

---

JEV Codex Pilot turns a backlog into a clear, controlled development workflow. Bring your projects, context, and ideas into one focused cockpit. JEV sizes every 
task and recommends the right Codex model and reasoning level. Launch focused work with the confidence that each ticket has its own plan.

Watch Codex work live, with progress, verification, visuals, and token usage in view. Keep project memory close through an editable `AGENTS.md` context. Move 
from idea to implementation without losing the thread. Review completed work, recover tasks, and inspect every local Git change. See JEV usage and estimated cost as your session moves forward.

One workspace to turn sharper decisions into better software, faster.

---

## See JEV Codex Pilot in action

![JEV Codex Pilot example1](assets/1.png)

![JEV Codex Pilot example2](assets/2.png)

---

## Getting your Vercel AI Gateway API key

To use JEV, you need a Vercel account and an AI Gateway API key.

1. Create a Vercel account or sign in at [Vercel](https://vercel.com).
2. Open the [JEV model page on Vercel AI Gateway](https://vercel.com/ai-gateway/models/jev).
3. Follow the instructions to enable AI Gateway and create an API key.
4. Copy your API key and add it to the application configuration.
5. Start the classification process.

The API key is used to authenticate requests to JEV through Vercel AI Gateway.

---

## Quickstart

### Install

```bash
npm install
```

### Run

```bash
npm run dev
```

Open `http://localhost:5173`, configure the Vercel AI Gateway key in Settings, and select or create a local project.

## Optional Telegram bot

Telegram can provide a private mobile view of project progress and a guided way to add tickets. It is disabled by default and works only while the local JEV API server is running.

In **Settings**, paste the BotFather token and save it. The first private chat to send `/start` is paired automatically, its numeric ID is stored in `config/config.toml`, and the integration is enabled. The token can be revealed from the local settings dialog and is never sent to a project or Codex. Once paired, every other Telegram chat is ignored, preventing other users from reading project data or creating work.

`/start` is the only command needed. It opens a single button-driven dashboard for project progress, ticket creation, and explicit Codex launches. The bot edits that dashboard in place, accepts only actions valid for the current step, removes typed ticket descriptions from the chat, and offers a confirmed delete action immediately after ticket creation.

When the bot service or a new `/start` session begins, it clears the private chat before presenting a fresh dashboard. Telegram only permits bots to delete messages sent within the previous 48 hours, so older messages may remain when Telegram enforces that platform limit.
