import { z } from "zod";
export function config(env = process.env) {
  return z
    .object({
      NODE_ENV: z
        .enum(["development", "test", "production"])
        .default("development"),
      PORT: z.coerce.number().int().min(1).max(65535).default(3000),
      HOST: z.string().default("127.0.0.1"),
      APP_ORIGIN: z.string().url().default("http://localhost:3000"),
      DATABASE_URL: z.string().min(1),
      REDIS_URL: z.string().min(1),
      SESSION_DAYS: z.coerce.number().int().min(1).max(30).default(7),
      DSH_MODEL: z.string().default("deepseek-v4-flash"),
      DSH_PROVIDER: z.string().default("deepseek-official"),
      DEEPSEEK_API_KEY: z.string().optional(),
      EXA_API_KEY: z.string().optional(),
      DEEPSEEK_BASE_URL: z
        .string()
        .url()
        .default("https://api.deepseek.com/anthropic"),
      DSH_TIMEOUT_MS: z.coerce
        .number()
        .int()
        .min(1000)
        .max(600000)
        .default(120000),
      DATA_DIR: z.string().default("var"),
      REGISTRATION_ENABLED: z.enum(["true", "false"]).default("true"),
    })
    .parse(env);
}
