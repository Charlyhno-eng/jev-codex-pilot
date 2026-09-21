![JEV Codex Pilot banner](assets/jev-codex-pilot-banner2.png)

# JEV Codex Pilot

JEV Codex Pilot is a local control center for turning software ideas into focused, traceable Codex work. It analyses each ticket before execution, keeps project context close, chooses an appropriate model and reasoning effort, and shows the complete development run as it happens.

The workflow is designed to reduce wasted context and unnecessary reasoning. JEV scores ticket precision and task breakdown, groups compatible work when possible, routes simple verification turns to low effort, escalates repair work when needed, and compacts long running threads automatically. These choices can reduce token usage by roughly **20–40% in typical mixed workloads**, with higher savings possible in test heavy queues. They are practical estimates, not guaranteed benchmarks: complex tickets, repeated fixes, and large repositories can reduce or remove the gain.

You keep control at every stage. Review the project files and Git state, edit `AGENTS.md`, inspect live Codex events, follow verification results, recover tasks, and review local changes from one workspace. Token totals are reported from completed Codex turns, while account usage is clearly labelled when available.

JEV currently uses the **Vercel AI Gateway API** for ticket analysis and usage data. The integration is kept in the project code so developers can adapt it to another provider or a self-hosted API when needed.

## See JEV Codex Pilot in action

![JEV Codex Pilot example1](assets/1.png)

![JEV Codex Pilot example2](assets/2.png)

## Quickstart

### Install

```bash
npm install
```

### Run

```bash
npm run dev
```

Open `http://localhost:5173`, configure the available provider in Settings, then select or create a local project.

During development, JEV can route successive Codex turns to different model tiers and reasoning efforts. A turn keeps its selected settings until it finishes; the next turn can be routed based on the work still required. Verification normally uses a low effort route, while failed checks can trigger a stronger repair route. Every route is visible in the backend logs and in the execution console.

The task breakdown score is advisory. It indicates whether a ticket looks like one focused unit of work and never blocks execution.

## Telegram

The optional Telegram bot provides a private progress view, guided ticket creation, and explicit Codex launches. It is disabled by default, pairs one private chat, and sends a completion summary when a development run ends.

## Project principles

- JEV analyses projects without changing their files or running their tests.
- Codex runs only after an explicit user action.
- Project history, context, and execution data remain separated per project.
- API keys stay local and are never shown in logs or UI output.
