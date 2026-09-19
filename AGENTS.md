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
