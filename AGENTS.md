# Public source collaboration rules

- This repository contains publishable source code, tests and generic build templates only.
- Use an explicitly configured pseudonymous Git author/committer and a GitHub noreply address. Never use inferred local OS identity.
- Keep production deployment details, personal paths and operational notes in the private companion repository.
- Never commit live database contents, user records, answer datasets, dumps, backups, credentials, cookies, tokens, private keys, logs or screenshots, even to the private companion repository.
- Database schemas, migrations and queries are source code, not live data; they remain here so this application can build and initialize a new database.
- Check git status before editing, preserve unrelated work, test changes, review the diff, stage explicit paths, and commit a non-sensitive work summary.
- Keep feature modules separate. Do not add independent features to application entry points.
- This public repository has a sanitized history. Never merge or push branches from the private repository into it. Transfer reviewed source changes as new commits in this repository instead.
- Do not deploy or upload secrets through Git. The private operations repository governs production deployment.

## Work summary

### 2026-09-19: Separate public source and private operations

- Changes: rebuilt public branch history with pseudonymous commit metadata; removed private deployment notes and data directories from public history; retained buildable application source and database initialization scripts.
- Purpose: prevent personal identity, real infrastructure details and business data from being published with source releases.
- Validation: full-history path/content/identity checks passed before publication; PostgreSQL-backed full Go race tests, go vet, 50 frontend tests and the production web build passed; application source is byte-identical to the verified private release. No live data or credentials are included.

### 2026-09-21: Select enrolled courses alongside an optional fixed entry

- Changes: merge the current account's paginated enrolled courses with the optional fixed course; add a homepage course selector with account-scoped remembered selection, explicit refresh and query-failure feedback. Task start/recovery and grade reads follow the selected classroom without starting or enrolling on selection.
- Fixes: grade refresh no longer replaces the entire catalog with one course. Late account/course responses are discarded, task details query their own course, and pending ambiguous starts lock selection. Only the fixed course retains the existing explicit-start free enrollment path.
- Validation: isolated full PostgreSQL Go race tests, go vet, 60 frontend tests and production build passed; browser mock verified course switching, exact start URL, state recovery, pagination/error handling and desktop/mobile layout. Production release is maintained from the private repository; no operational data or credentials are included here.

### 2026-09-21: Keep only the course dropdown and original titles

- Changes: remove the course picker frame, visible label, refresh button, explanations and appended class/status labels. Keep the accessible dropdown and the original platform course names.
- Related fix: a pinned but unenrolled course no longer triggers automatic grade requests; the server also prevents legacy clients from probing its grade before enrollment is known.
- Validation: 61 frontend tests, production build and PostgreSQL catalog/httpapi race passed; browser mock verified minimal markup, course switching/start/resume and desktop/mobile layouts. No live enrollment or task was started for testing.

### 2026-09-21: Resume a whole-course task after answer-only completion

- Changes: distinguish a completed homework/collector-only job from a full-course job; the homepage returns to Start and starts the four core modules without resubmitting completed answers. Active/paused full-course jobs and pending starts remain recoverable, and detail views label scoped completion as “this task completed”.
- Validation: PostgreSQL full Go race, vet, 69 frontend tests and production build passed; no live platform writes were used.
