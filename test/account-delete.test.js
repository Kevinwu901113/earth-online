import test from "node:test";
import assert from "node:assert/strict";
import { deleteAccount } from "../scripts/account-delete.js";

const userId = "e0c48796-7427-408b-92b8-7188f1ccdcf5";
function fixture({
  present = true,
  running = false,
  missing = false,
  failure,
} = {}) {
  const initial = {
    users: [userId, "another-user"],
    documents: [
      { id: "private-main", namespace: "main", ownerId: userId },
      {
        id: "case-variant-private",
        namespace: "main",
        ownerId: userId.toUpperCase(),
      },
      { id: "other-private", namespace: "main", ownerId: "another-user" },
      { id: "curated", namespace: "main", ownerId: null },
      { id: "isolated-lab", namespace: "workbench", ownerId: userId },
    ],
  };
  let state = structuredClone(initial),
    draft,
    released = false;
  const calls = [];
  const client = {
    query: async (sql, args) => {
      calls.push({ sql, args });
      if (sql === "BEGIN") {
        draft = structuredClone(state);
        return { rows: [] };
      }
      if (sql === "COMMIT") {
        state = draft;
        return { rows: [] };
      }
      if (sql === "ROLLBACK") {
        draft = undefined;
        return { rows: [] };
      }
      if (sql.startsWith("SELECT user_id FROM players"))
        return { rows: missing ? [] : [{ user_id: userId }] };
      if (sql.startsWith("SELECT id FROM agent_jobs"))
        return { rows: running ? [{ id: "running-job" }] : [] };
      if (sql.startsWith("SELECT to_regclass")) return { rows: [{ present }] };
      if (sql.startsWith("DELETE FROM earth_knowledge_documents")) {
        if (failure === "knowledge") throw new Error("knowledge_delete_failed");
        assert.equal(
          sql,
          "DELETE FROM earth_knowledge_documents WHERE namespace=$1 AND lower(owner_id)=$2",
        );
        draft.documents = draft.documents.filter(
          (doc) =>
            !(
              doc.namespace === args[0] &&
              doc.ownerId?.toLowerCase() === args[1]
            ),
        );
        return { rows: [] };
      }
      if (sql.startsWith("DELETE FROM users")) {
        if (failure === "account") throw new Error("account_delete_failed");
        draft.users = draft.users.filter((id) => id !== args[0]);
        return { rows: [] };
      }
      assert.fail("Unexpected deletion query");
    },
    release: () => {
      released = true;
    },
  };
  return {
    pool: { connect: async () => client },
    calls,
    initial,
    state: () => state,
    released: () => released,
  };
}

test("account deletion removes only this owner's main knowledge in the account transaction", async () => {
  const value = fixture();
  await deleteAccount(value.pool, userId);
  assert.deepEqual(value.state().users, ["another-user"]);
  assert.deepEqual(
    value.state().documents.map((doc) => doc.id),
    ["other-private", "curated", "isolated-lab"],
  );
  const deletes = value.calls.filter((call) => call.sql.startsWith("DELETE"));
  assert.deepEqual(
    deletes.map((call) => call.args),
    [["main", userId], [userId]],
  );
  assert.equal(value.calls[0].sql, "BEGIN");
  assert.equal(value.calls.at(-1).sql, "COMMIT");
  assert.equal(value.released(), true);
});

test("legacy databases without a knowledge table can still delete accounts", async () => {
  const value = fixture({ present: false });
  await deleteAccount(value.pool, userId);
  assert.deepEqual(value.state().users, ["another-user"]);
  assert.ok(
    !value.calls.some((call) =>
      call.sql.startsWith("DELETE FROM earth_knowledge"),
    ),
  );
});

test("UUID case cannot leave private knowledge behind after account deletion", async () => {
  const value = fixture();
  await deleteAccount(value.pool, userId.toUpperCase());
  assert.deepEqual(value.state().users, ["another-user"]);
  assert.deepEqual(
    value.state().documents.map((doc) => doc.id),
    ["other-private", "curated", "isolated-lab"],
  );
});

test("missing accounts and running jobs prevent all deletion", async () => {
  for (const options of [{ missing: true }, { running: true }]) {
    const value = fixture(options);
    await assert.rejects(deleteAccount(value.pool, userId));
    assert.deepEqual(value.state(), value.initial);
    assert.ok(!value.calls.some((call) => call.sql.startsWith("DELETE")));
    assert.equal(value.calls.at(-1).sql, "ROLLBACK");
    assert.equal(value.released(), true);
  }
});

test("knowledge and account deletion failures roll back the entire deletion", async () => {
  for (const failure of ["knowledge", "account"]) {
    const value = fixture({ failure });
    await assert.rejects(deleteAccount(value.pool, userId));
    assert.deepEqual(value.state(), value.initial);
    assert.equal(value.calls.at(-1).sql, "ROLLBACK");
    assert.equal(value.released(), true);
  }
});
