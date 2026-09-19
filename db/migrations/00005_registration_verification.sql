-- +goose Up
CREATE TABLE registration_settings (
 id boolean PRIMARY KEY DEFAULT true CHECK (id),
 email_verification_required boolean NOT NULL DEFAULT true,
 updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO registration_settings(id) VALUES(true);
CREATE TABLE registration_challenges (
 email text PRIMARY KEY,
 id uuid NOT NULL,
 code_hash text NOT NULL,
 key_id text NOT NULL,
 expires_at timestamptz NOT NULL,
 attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
 used_at timestamptz,
 sent_at timestamptz NOT NULL DEFAULT now(),
 window_started_at timestamptz NOT NULL DEFAULT now(),
 send_count integer NOT NULL DEFAULT 1 CHECK (send_count BETWEEN 1 AND 5)
);
-- +goose Down
DROP TABLE registration_challenges, registration_settings;
