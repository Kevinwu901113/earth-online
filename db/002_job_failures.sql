-- Keep public messages and bounded, value-free diagnostics with the durable job.
ALTER TABLE agent_jobs ADD COLUMN IF NOT EXISTS failure jsonb;
