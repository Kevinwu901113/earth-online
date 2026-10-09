import test from "node:test";
import assert from "node:assert/strict";
import { runOne } from "../src/worker.js";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function fixture() {
  const seen = { finished: [], failures: [] };
  const job = {
    id: "job",
    user_id: "owner",
    kind: "chat",
    input: { messageId: "message" },
  };
  const context = {
    messages: [
      { id: "message", role: "user", content: "请帮我安排今晚的阅读任务" },
    ],
    goals: [],
    plans: [],
  };
  const repo = {
    expire: async () => {},
    claim: async () => job,
    context: async () => context,
    pool: { query: async () => ({ rows: [] }) },
    job: async () => ({ status: "running" }),
    finish: async (_job, output) => seen.finished.push(output),
    fail: async (_job, failure) => {
      seen.failures.push(failure);
      return false;
    },
  };
  return { repo, seen };
}

test("worker passes only the remaining deadline after context and RAG to the agent", async () => {
  const { repo, seen } = fixture();
  const original = repo.context;
  repo.context = async (...args) => {
    await delay(20);
    return original(...args);
  };
  let remaining,
    retrievals = 0;
  const knowledge = {
    retrieve: async () => {
      retrievals++;
      await delay(20);
      return { available: false, reason: "knowledge_not_ready" };
    },
  };
  const agent = {
    run: async (_job, _context, _signal, options) => {
      remaining = options.timeoutMs;
      return { reply: "fixture" };
    },
  };
  assert.equal(await runOne(repo, agent, 2000, undefined, knowledge), true);
  assert.equal(retrievals, 1);
  assert.ok(remaining > 0 && remaining < 1980);
  assert.equal(seen.finished.length, 1);
  assert.deepEqual(seen.failures, []);
});

test("a RAG deadline failure never starts a fresh full model budget", async () => {
  const { repo, seen } = fixture();
  let calls = 0,
    retrievalSignal;
  const knowledge = {
    retrieve: async (_query, options) => {
      retrievalSignal = options.signal;
      return new Promise(() => {});
    },
  };
  assert.equal(
    await runOne(
      repo,
      {
        run: async () => {
          calls++;
        },
      },
      35,
      undefined,
      knowledge,
    ),
    true,
  );
  assert.equal(calls, 0);
  assert.equal(retrievalSignal.aborted, true);
  assert.equal(seen.finished.length, 0);
  assert.equal(seen.failures[0].code, "model_timeout");
});

test("worker rejects a late agent result before settlement", async () => {
  const { repo, seen } = fixture();
  const agent = {
    run: async () => {
      await delay(70);
      return { reply: "late" };
    },
  };
  await runOne(repo, agent, 35);
  assert.equal(seen.finished.length, 0);
  assert.equal(seen.failures[0].code, "model_timeout");
});

test("worker cancellation during retrieval stays a fixed interruption and cannot settle", async () => {
  const { repo, seen } = fixture();
  const stop = new AbortController();
  let calls = 0;
  const knowledge = {
    retrieve: async () => {
      stop.abort("PRIVATE_ABORT_REASON");
      return new Promise(() => {});
    },
  };
  await runOne(
    repo,
    {
      run: async () => {
        calls++;
      },
    },
    2000,
    stop.signal,
    knowledge,
  );
  assert.equal(calls, 0);
  assert.equal(seen.finished.length, 0);
  assert.equal(seen.failures[0].code, "job_interrupted");
  assert.ok(!JSON.stringify(seen.failures).includes("PRIVATE"));
});
