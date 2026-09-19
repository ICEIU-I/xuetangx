-- +goose Up
CREATE TABLE auth_challenges (
 id uuid PRIMARY KEY,
 user_id uuid NOT NULL REFERENCES users(id),
 kind text NOT NULL CHECK (kind IN ('reset')),
 code_hash text NOT NULL,
 expires_at timestamptz NOT NULL,
 attempts integer NOT NULL DEFAULT 0,
 used_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_challenges_user ON auth_challenges(user_id, kind, created_at DESC);

-- +goose Down
DROP TABLE auth_challenges;
