// Operator-only CLI. No public endpoint can publish standards or certify external evidence.
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { standardSchema } from "../src/standards.js";
import { config } from "../src/config.js";
import { makePool, transaction } from "../src/db.js";
import { Repository } from "../src/repository.js";
import { deleteAccount } from "./account-delete.js";
const [action, path] = process.argv.slice(2);
if (
  !["publish-standard", "verify-external", "delete-account"].includes(action) ||
  !path
)
  throw new Error(
    "Usage: npm run admin -- publish-standard|verify-external|delete-account /path/to/reviewed.json",
  );
const data = JSON.parse(await readFile(path, "utf8")),
  pool = makePool(config().DATABASE_URL);
try {
  if (action === "publish-standard") {
    const input = standardSchema.parse(data);
    const { id, version, ...body } = input;
    await pool.query(
      "INSERT INTO public_standards(id,version,body) VALUES($1,$2,$3)",
      [id, version, body],
    );
    console.log("Published immutable standard", id, version);
  } else if (action === "verify-external") {
    const i = z
      .object({
        userId: z.uuid(),
        goalId: z.uuid(),
        reviewedBy: z.string().min(1),
        evidenceReference: z.string().min(1),
        note: z.string().min(1),
        accepted: z.boolean(),
      })
      .strict()
      .parse(data);
    await transaction(pool, async (c) => {
      const {
        rows: [p],
      } = await c.query(
        "SELECT state FROM players WHERE user_id=$1 FOR UPDATE",
        [i.userId],
      );
      const g = p?.state.goals.find((g) => g.id === i.goalId);
      if (
        g?.status !== "awaiting_external" ||
        g.externalEvidence?.status !== "pending"
      )
        throw new Error("Goal must have pending external evidence");
      g.externalEvidence = {
        ...g.externalEvidence,
        ...i,
        status: i.accepted ? "verified" : "rejected",
        verifiedAt: new Date().toISOString(),
      };
      if (i.accepted) g.status = "completed";
      await new Repository(pool).writeState(
        c,
        i.userId,
        p.state,
        [],
        "goal.external.reviewed",
        { goalId: i.goalId, reviewedBy: i.reviewedBy, accepted: i.accepted },
      );
    });
    console.log("External evidence review recorded");
  } else {
    const i = z
      .object({ userId: z.uuid(), confirmUserId: z.uuid() })
      .strict()
      .refine((x) => x.userId === x.confirmUserId)
      .parse(data);
    // Stop this user's running jobs before this operator action.
    await deleteAccount(pool, i.userId);
    console.log(
      "Account deleted; Redis context copies expire within 30 minutes. Apply the documented backup retention policy.",
    );
  }
} finally {
  await pool.end();
}
