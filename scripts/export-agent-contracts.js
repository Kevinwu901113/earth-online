import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { outputContract } from "../src/agent-output.js";
import { intentSchema } from "../src/intent.js";
const directory = resolve(process.argv[2] ?? "docs/contracts");
await mkdir(directory, { recursive: true });
for (const kind of [
  "chat",
  "route",
  "skills",
  "assessment",
  "review",
  "intent",
]) {
  const schema =
    kind === "intent"
      ? z.toJSONSchema(intentSchema, { io: "input" })
      : outputContract(kind);
  await writeFile(
    resolve(directory, kind + ".schema.json"),
    JSON.stringify(schema, null, 2) + "\n",
  );
}
console.log("Exported six contracts from the runtime Zod schemas.");
