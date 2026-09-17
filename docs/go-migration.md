# Go / PostgreSQL migration

Baseline: `f939f21`. The legacy Node implementation remains available as a behavioral oracle during migration. Production Go must not invoke Node or read legacy JSON as runtime storage.

## Contract

- Existing `/api/session`, cookie, course, workflow, advanced module and answer-bank routes keep their business response shapes. All require an authenticated, verified application user.
- Existing SSE `hello`, `workflow`, `accounts`, `rate-limit`, `video`, `article`, `discussion`, `answer-bank` and homework progress events remain supported. Events are owner-scoped and include durable IDs/revisions.
- CLI: check, verify, video, article, discussion, collect-answers, submit, complete-course. Exit 0 means success, 2 means incomplete/waiting/paused, 1 means an error. Ctrl-C pauses the remote job.
- Default module concurrency 3 (range 1–3). No fixed pacing or local per-minute submission quotas. Account-wide in-flight submissions are bounded at 3. Actual server throttles cause cooldown; reads and other accounts can proceed.
- Unknown question submissions reconcile after 1/2/4 seconds. Only three explicit same-version unanswered reads authorize one of at most two durable additional attempts. Discussion unknowns never auto-repost.
- Shared answers must match classroom, exercise, problem and content version. User answers are private and never a standard-answer source.

## Delivery sequence

1. PostgreSQL schema, generated queries, configuration, encryption and migration tooling.
2. Verified-user authentication, revocable sessions/tokens, email outbox and platform account ownership.
3. Platform read APIs, normalized shared bank, fingerprint compatibility and import tooling.
4. Durable operation journal, fair account broker, Go IPC workers and recoverable scheduler.
5. Authenticated compatibility routes, replayable SSE, Vue multiuser screens and Go CLI.
6. Compose deployment, backup/restore, end-to-end and failure-injection verification.

Each independent delivery includes tests, an AGENTS.md summary and a commit. Legacy real data and credentials must remain untouched. Upstream writes are tested against a simulator only.

## Deployment decisions

Single Linux host: Go app + PostgreSQL 17 + Caddy, external SMTP. Open email-verified registration; global standard bank, private account/task state. Encrypted platform credentials use externally supplied versioned AES-256-GCM keys. Worker processes receive no secrets. Default capacity: 10 courses globally, 2 per application user. Restarted jobs stay paused until explicitly resumed.

## Migration and rollback

Import requires explicit legacy platform-user to application-user mapping. Dry-run first; preserve source files and unknown operations, never reset retry counts, ignore obsolete quota/PID/lock files. Runtime storage has no JSON fallback. Unverifiable legacy answers stay pending verification. After Go makes upstream writes, a rollback must retain PostgreSQL operation history; never restart Node against a stale JSON snapshot.
