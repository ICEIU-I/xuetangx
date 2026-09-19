# Public source and private data

This public repository contains the application source, tests and generic build examples.

`db/migrations`, `db/queries` and database access code define a new database. They do not contain any production database records and are required to build and run the application.

Production deployment notes belong in the private companion repository. Real database contents and backups remain outside both Git repositories, encrypted in access-controlled storage. A private Git repository is not a secret manager or a database backup destination.

When publishing later changes, copy only reviewed source-tree changes into this repository. Do not merge private repository history, copy its `.git` directory, or publish private operational files. Configure both author and committer identity explicitly before committing.
