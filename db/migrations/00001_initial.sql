-- +goose Up
CREATE TABLE users (
 id uuid PRIMARY KEY, email text NOT NULL, password_hash text NOT NULL,
 verified boolean NOT NULL DEFAULT false, disabled boolean NOT NULL DEFAULT false,
 admin boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email ON users(lower(email));
CREATE TABLE sessions (
 token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), csrf_hash text NOT NULL,
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE auth_tokens (
 token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id),
 kind text NOT NULL CHECK (kind IN ('verify','reset','api')), name text NOT NULL DEFAULT '',
 expires_at timestamptz NOT NULL, used_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_tokens_user ON auth_tokens(user_id);
CREATE TABLE mail_outbox (
 id uuid PRIMARY KEY, recipient text NOT NULL, subject text NOT NULL,
 encrypted_body bytea NOT NULL, nonce bytea NOT NULL, key_id text NOT NULL,
 attempts integer NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT now(),
 sent_at timestamptz, lease_until timestamptz, last_error text NOT NULL DEFAULT ''
);
CREATE TABLE platform_accounts (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES users(id),
 platform_user_id bigint NOT NULL UNIQUE CHECK (platform_user_id > 0),
 display_name text NOT NULL DEFAULT '', role text CHECK (role IN ('primary','test')),
 revision bigint NOT NULL DEFAULT 1, valid boolean NOT NULL DEFAULT false,
 connected_at timestamptz, UNIQUE(owner_id,role), UNIQUE(id,owner_id)
);
CREATE TABLE platform_credentials (
 account_id uuid PRIMARY KEY REFERENCES platform_accounts(id), key_id text NOT NULL,
 nonce bytea NOT NULL, ciphertext bytea NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE courses (
 id uuid PRIMARY KEY, classroom_id bigint NOT NULL UNIQUE CHECK (classroom_id>0),
 sign text NOT NULL, course_sign text NOT NULL, title text NOT NULL DEFAULT '', url text NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE course_units (
 id uuid PRIMARY KEY, course_id uuid NOT NULL REFERENCES courses(id), leaf_id bigint NOT NULL,
 kind text NOT NULL CHECK(kind IN ('video','article','discussion','homework')),
 leaf_type integer NOT NULL, title text NOT NULL DEFAULT '', active boolean NOT NULL DEFAULT true,
 UNIQUE(course_id,leaf_id)
);
CREATE TABLE exercises (
 id uuid PRIMARY KEY, unit_id uuid NOT NULL REFERENCES course_units(id),
 platform_exercise_id bigint NOT NULL, UNIQUE(unit_id,platform_exercise_id)
);
CREATE TABLE question_versions (
 id uuid PRIMARY KEY, exercise_id uuid NOT NULL REFERENCES exercises(id), problem_id bigint NOT NULL,
 fingerprint text NOT NULL, algorithm text NOT NULL DEFAULT 'canonical-v3', legacy_fingerprint text NOT NULL DEFAULT '',
 question_type text NOT NULL, platform_type text NOT NULL, body_html text NOT NULL DEFAULT '',
 position integer NOT NULL DEFAULT 0, blank_count integer NOT NULL DEFAULT 0,
 metadata jsonb NOT NULL DEFAULT '{}', verified boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(exercise_id,problem_id,algorithm,fingerprint)
);
CREATE TABLE question_options (
 question_id uuid NOT NULL REFERENCES question_versions(id), key text NOT NULL, position integer NOT NULL,
 content text NOT NULL, extra jsonb NOT NULL DEFAULT '{}', PRIMARY KEY(question_id,key)
);
CREATE TABLE standard_answers (
 question_id uuid PRIMARY KEY REFERENCES question_versions(id),
 status text NOT NULL CHECK(status IN ('captured','missing','conflict','unverified','reference')),
 reference_text text NOT NULL DEFAULT '', updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE answer_items (
 question_id uuid NOT NULL REFERENCES standard_answers(question_id), slot integer NOT NULL,
 variant integer NOT NULL DEFAULT 0, value text NOT NULL, PRIMARY KEY(question_id,slot,variant)
);
CREATE TABLE answer_sources (
 id uuid PRIMARY KEY, question_id uuid NOT NULL REFERENCES question_versions(id),
 owner_id uuid REFERENCES users(id), account_id uuid REFERENCES platform_accounts(id),
 source text NOT NULL, answer_digest text NOT NULL, evidence jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(question_id,answer_digest,source)
);
CREATE TABLE account_courses (
 account_id uuid NOT NULL REFERENCES platform_accounts(id), course_id uuid NOT NULL REFERENCES courses(id),
 checked_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(account_id,course_id)
);
CREATE TABLE account_unit_states (
 account_id uuid NOT NULL REFERENCES platform_accounts(id), unit_id uuid NOT NULL REFERENCES course_units(id),
 sku_id bigint NOT NULL DEFAULT 0, progress double precision NOT NULL DEFAULT 0, locked boolean NOT NULL DEFAULT false,
 checked_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(account_id,unit_id)
);
CREATE TABLE account_question_states (
 account_id uuid NOT NULL REFERENCES platform_accounts(id), question_id uuid NOT NULL REFERENCES question_versions(id),
 my_count integer NOT NULL CHECK(my_count>=0), is_right boolean, checked_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(account_id,question_id)
);
CREATE TABLE jobs (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES users(id), account_id uuid NOT NULL,
 course_id uuid NOT NULL REFERENCES courses(id), status text NOT NULL DEFAULT 'queued',
 concurrency integer NOT NULL CHECK(concurrency BETWEEN 1 AND 3), submit_unanswered boolean NOT NULL DEFAULT true,
 targets jsonb NOT NULL DEFAULT '[]', unit_id bigint, revision bigint NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(account_id,owner_id) REFERENCES platform_accounts(id,owner_id), UNIQUE(id,owner_id)
);
CREATE UNIQUE INDEX jobs_active_course ON jobs(account_id,course_id) WHERE status IN ('queued','running','waiting_input');
CREATE INDEX jobs_owner_created ON jobs(owner_id,created_at DESC);
CREATE TABLE job_modules (
 job_id uuid NOT NULL REFERENCES jobs(id), kind text NOT NULL CHECK(kind IN ('video','article','discussion','homework','collector')),
 status text NOT NULL DEFAULT 'queued', generation bigint NOT NULL DEFAULT 0, restarts integer NOT NULL DEFAULT 0,
 total integer NOT NULL DEFAULT 0, message text NOT NULL DEFAULT '', PRIMARY KEY(job_id,kind)
);
CREATE TABLE job_items (
 job_id uuid NOT NULL, kind text NOT NULL, leaf_id bigint NOT NULL, problem_id bigint NOT NULL DEFAULT 0,
 title text NOT NULL DEFAULT '', status text NOT NULL, error text NOT NULL DEFAULT '',
 updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(job_id,kind,leaf_id,problem_id),
 FOREIGN KEY(job_id,kind) REFERENCES job_modules(job_id,kind)
);
CREATE TABLE operations (
 id uuid PRIMARY KEY, op_key text NOT NULL UNIQUE, legacy_key text NOT NULL DEFAULT '',
 owner_id uuid NOT NULL REFERENCES users(id), account_id uuid NOT NULL,
 classroom_id bigint NOT NULL, leaf_id bigint NOT NULL, problem_id bigint NOT NULL DEFAULT 0,
 kind text NOT NULL, fingerprint text NOT NULL DEFAULT '', state text NOT NULL,
 network_retries integer NOT NULL DEFAULT 0 CHECK(network_retries BETWEEN 0 AND 2),
 retryable boolean NOT NULL DEFAULT true, attempt integer NOT NULL DEFAULT 0,
 result jsonb NOT NULL DEFAULT '{}', updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(account_id,owner_id) REFERENCES platform_accounts(id,owner_id)
);
CREATE INDEX operations_target ON operations(account_id,classroom_id,leaf_id,problem_id);
CREATE TABLE operation_attempts (
 id uuid PRIMARY KEY, operation_id uuid NOT NULL REFERENCES operations(id), sequence integer NOT NULL,
 state text NOT NULL, error_code text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(operation_id,sequence)
);
CREATE TABLE job_events (
 id bigserial PRIMARY KEY, owner_id uuid NOT NULL REFERENCES users(id), job_id uuid,
 event_type text NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(job_id,owner_id) REFERENCES jobs(id,owner_id)
);
CREATE INDEX job_events_owner ON job_events(owner_id,id);
CREATE TABLE event_outbox (
 id bigserial PRIMARY KEY, topic text NOT NULL, payload jsonb NOT NULL,
 delivered_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE import_runs (
 id uuid PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now(), status text NOT NULL
);
CREATE TABLE import_items (
 source_path text NOT NULL, digest text NOT NULL, run_id uuid NOT NULL REFERENCES import_runs(id),
 status text NOT NULL, message text NOT NULL DEFAULT '', PRIMARY KEY(source_path,digest)
);
CREATE TABLE migration_blocks (
 id uuid PRIMARY KEY, owner_id uuid REFERENCES users(id), classroom_id bigint NOT NULL,
 source_path text NOT NULL, reason text NOT NULL, resolved_at timestamptz,
 UNIQUE(source_path,reason)
);

-- +goose Down
DROP TABLE migration_blocks, import_items, import_runs, event_outbox, job_events, operation_attempts,
 operations, job_items, job_modules, jobs, account_question_states, account_unit_states, account_courses,
 answer_sources, answer_items, standard_answers, question_options, question_versions, exercises,
 course_units, courses, platform_credentials, platform_accounts, mail_outbox, auth_tokens, sessions, users;
