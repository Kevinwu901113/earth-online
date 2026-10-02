import { config } from "./config.js";
import { makePool, migrate } from "./db.js";
const pool = makePool(config().DATABASE_URL);
try {
  await migrate(pool);
  console.log("Database schema ready");
} finally {
  await pool.end();
}
