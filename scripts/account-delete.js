import { transaction } from "../src/db.js";

export async function deleteAccount(pool, userId) {
  // The admin contract accepts UUIDs; users.id normalizes their case, text owners do not.
  userId = userId.toLowerCase();
  return transaction(pool, async (client) => {
    const {
      rows: [player],
    } = await client.query(
      "SELECT user_id FROM players WHERE user_id=$1 FOR UPDATE",
      [userId],
    );
    if (!player) throw new Error("User not found");
    const {
      rows: [job],
    } = await client.query(
      "SELECT id FROM agent_jobs WHERE user_id=$1 AND status='running' LIMIT 1",
      [userId],
    );
    if (job) throw new Error("Wait for or cancel running jobs first");
    const {
      rows: [knowledge],
    } = await client.query(
      "SELECT to_regclass('earth_knowledge_documents') IS NOT NULL AS present",
    );
    if (knowledge?.present)
      await client.query(
        "DELETE FROM earth_knowledge_documents WHERE namespace=$1 AND lower(owner_id)=$2",
        ["main", userId],
      );
    // Knowledge chunks cascade from documents; core account data cascades from users.
    await client.query("DELETE FROM users WHERE id=$1", [userId]);
  });
}
