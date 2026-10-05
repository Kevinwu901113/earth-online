import pg from "pg";
import { readFile } from "node:fs/promises";
export const makePool = (url) =>
  new pg.Pool({
    connectionString: url,
    max: 10,
    connectionTimeoutMillis: 5000,
  });
export async function transaction(pool, fn) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
export async function migrate(pool) {
  await transaction(pool, async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(718284901)");
    await c.query(
      await readFile(new URL("../db/001_initial.sql", import.meta.url), "utf8"),
    );
    await c.query(
      "INSERT INTO schema_migrations(version) VALUES ('001') ON CONFLICT DO NOTHING",
    );
    await c.query(
      await readFile(
        new URL("../db/002_job_failures.sql", import.meta.url),
        "utf8",
      ),
    );
    await c.query(
      "INSERT INTO schema_migrations(version) VALUES ('002') ON CONFLICT DO NOTHING",
    );
  });
}
