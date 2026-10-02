import { createClient } from "redis";
import { config as getConfig } from "./config.js";
import { makePool } from "./db.js";
import { buildApp } from "./app.js";
const config = getConfig(),
  pool = makePool(config.DATABASE_URL),
  cache = createClient({
    url: config.REDIS_URL,
    socket: { connectTimeout: 5000 },
    disableOfflineQueue: true,
  });
cache.on("error", () => console.error("Redis unavailable"));
await cache.connect();
await pool.query("SELECT version FROM schema_migrations LIMIT 1");
const app = await buildApp({ pool, cache, config, logger: true });
await app.listen({ host: config.HOST, port: config.PORT });
let closing = false;
for (const sig of ["SIGTERM", "SIGINT"])
  process.once(sig, async () => {
    if (closing) return;
    closing = true;
    await app.close();
    await cache.close();
    await pool.end();
  });
