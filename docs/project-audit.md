# Project audit — 2026-10-10

The audit reviewed the API, persisted ticket queue, orchestration and recovery, Git workspace, project/file access, CLI, skill lifecycle, native hooks, polling, and web composition. Existing uncommitted work was retained. Checks ran against JEV and temporary test fixtures; no registered target project's code or tests were changed or executed, and no live Codex implementation or provider evaluation was launched.

## Corrections

- Reject browser API requests from external origins and untrusted hosts. Remove wildcard CORS headers and require a local browser origin for saved credentials, while retaining local CLI access.
- Validate JSON object bodies and task descriptions, decode request chunks together to preserve UTF-8, and report malformed requests as client errors.
- Allow disabling Human in the loop during execution without attempting to approve an active ticket. Apply the saved preference in the local CLI and return from API-backed CLI polling when review pauses a sequence.
- Make explicit ticket re-evaluation invalidate the saved recommendation. Preserve ordinary preparation reuse and concurrent evaluation sharing.
- Protect a selected ticket during preparation and execution from editing, removal, skipping, and route adjustment. Reject actions against removed projects, and recheck Git activity after asynchronous request-body reads.
- Preserve manual model and reasoning choices through reloads and manual retries. Recheck continuity when a previously reviewed next ticket's description changes.
- Require confirmation before reporting successful compaction or archival. Handle app-server input errors and finalization exceptions so tickets record failures and release execution slots.
- Hide private paths and mask credentials in Git previews. Refuse external/private untracked link targets, disable Git text-conversion previews, and bound Git subprocesses. Show initial staged files, nested untracked files, and complete rename patches.
- Reject malformed hook confidences and inherited object properties masquerading as choice answers.
- Preserve unsent drafts and edits made during ticket submission, wait for selected images to finish loading, and enforce the four-image limit across existing and new references. Successful ticket creation remains successful if its subsequent board refresh fails.

## Validation

The original build, ESLint checks, and 222 tests passed before the audit. Added regression cases exercise the corrected request boundaries, human review, manual route persistence, Git previews, hook validation, continuity, finalization, and draft preservation.

Final checks:

| Check | Result |
| --- | --- |
| `npm run build` | Passed: TypeScript and production Vite build |
| `npm run lint` | Passed |
| `npm test` | Passed: 253 tests in 44 files, including 31 added regression cases |
| `git diff --check` | Passed |

## Runtime limits

The environment denies local TCP socket creation, so a real HTTP smoke test could not start. API behavior was verified through request/response handler integration tests. No browser automation tool or browser test runtime was available; web checks cover TypeScript, lint, rendered components, and state helpers. Real browser interaction, remote Git authentication/pushes, and live Codex/provider behavior remain unverified here. Passing checks do not prove that every possible bug is absent.
