CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS users (
 id uuid PRIMARY KEY, email text NOT NULL UNIQUE, password_hash text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
 token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS players (
 user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 version bigint NOT NULL DEFAULT 0, state jsonb NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS command_receipts (
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, key text NOT NULL,
 fingerprint text NOT NULL, response jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(user_id,key)
);
CREATE TABLE IF NOT EXISTS growth_ledger (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 source_id text NOT NULL, kind text NOT NULL, xp integer NOT NULL CHECK (xp>=0),
 attribute integer, rule_version text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(user_id,source_id,kind)
);
CREATE TABLE IF NOT EXISTS domain_events (
 sequence bigserial PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 type text NOT NULL, data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS domain_events_user ON domain_events(user_id,sequence);
CREATE TABLE IF NOT EXISTS agent_jobs (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 kind text NOT NULL, input jsonb NOT NULL, status text NOT NULL DEFAULT 'queued'
 CHECK(status IN ('queued','running','succeeded','failed','cancelled')),
 result jsonb, error text, attempt integer NOT NULL DEFAULT 0,
 lease_until timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_jobs_queue ON agent_jobs(status,created_at);
CREATE INDEX IF NOT EXISTS agent_jobs_user ON agent_jobs(user_id,created_at);
CREATE TABLE IF NOT EXISTS public_standards (
 id text NOT NULL, version integer NOT NULL, body jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(id,version)
);
