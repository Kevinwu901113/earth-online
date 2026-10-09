import { randomUUID } from "node:crypto";
import { inputSchema, parseGeneration } from "./contract.js";
import { fixture, exampleInput } from "./fixtures.js";
import { AgentError } from "./current/src/agent-output.js";
import { DshAgent } from "./current/src/agent.js";
import { initialState, applyCommand, settleJob } from "./current/src/domain.js";
import { config } from "./current/src/config.js";
import {
  labDataDir,
  getLabKnowledge,
  retrieveLabKnowledge,
  retrievalSummary,
} from "./knowledge.js";

export function agentConfig(env = process.env) {
  return {
    ...config({
      ...env,
      DATABASE_URL: "unused-in-lab",
      REDIS_URL: "unused-in-lab",
      DATA_DIR: labDataDir,
      DSH_TIMEOUT_MS: "120000",
      DSH_MAX_TOKENS: env.DSH_MAX_TOKENS || "16384",
    }),
    RAG_ENABLED: env.RAG_ENABLED === "false" ? "false" : "true",
    RAG_MODEL: env.RAG_MODEL || "Xenova/bge-small-zh-v1.5",
  };
}
export async function generate(
  raw,
  { agent, env = process.env, knowledge } = {},
) {
  const input = inputSchema.parse(raw);
  if (
    input.mode === "fixture" &&
    JSON.stringify(input.goal) !== JSON.stringify(exampleInput.goal)
  )
    throw Object.assign(new Error("fixture_input_mismatch"), {
      code: "fixture_input_mismatch",
    });
  const start = Date.now(),
    id = randomUUID(),
    user_id = "generation-lab",
    cfg = agentConfig(env);
  const state = initialState();
  state.profile.daily = input.goal.minutes;
  state.profile.preferences = input.preferences;
  const created = applyCommand(state, {
    type: "goal.create",
    ...input.goal,
    requiresExternal: input.evidenceMode === "external",
    kind: "main",
  });
  const goal = created.state.goals[0];
  const context = {
    profile: created.state.profile,
    goals: [goal],
    plans: [],
    records: [],
    notes: [],
    messages: [],
    submissions: [],
    achievements: [],
    standards: [],
  };
  context.knowledge =
    input.mode === "live"
      ? await retrieveLabKnowledge(
          knowledge ?? (!agent ? getLabKnowledge(env) : null),
          [
            input.goal.title,
            input.goal.base,
            input.goal.criterion,
            input.preferences,
          ].join("\n"),
          null,
        )
      : {
          available: false,
          reason: "fixture_mode",
          chunks: [],
          sources: [],
          untrusted: true,
        };
  cfg.DSH_TIMEOUT_MS = Math.max(0, cfg.DSH_TIMEOUT_MS - (Date.now() - start));
  if (input.mode === "live" && !cfg.DSH_TIMEOUT_MS)
    throw new AgentError("model_timeout", { phase: "retrieval" });
  let result;
  if (input.engine === "skills") {
    const job = {
      id,
      user_id,
      kind: "skills",
      input: {
        goal: input.goal,
        preferences: input.preferences,
        evidenceMode: input.evidenceMode,
      },
    };
    const output =
      input.mode === "fixture"
        ? fixture(input)
        : await (agent || new DshAgent(cfg)).run(job, context);
    result = parseGeneration(output, input);
  } else {
    const job = {
      id: created.result.jobId,
      user_id,
      kind: "route",
      input: {
        goalId: goal.id,
        revision: goal.revision,
        stage: 0,
        minutes: input.goal.minutes,
      },
    };
    const f = fixture(input),
      t = f.tasks[0];
    const output =
      input.mode === "fixture"
        ? {
            summary: "固定现有路线样例",
            minutes: input.goal.minutes,
            stat: 0,
            stages: [
              {
                name: t.name,
                criterion: t.criterion,
                exercise: t.name,
                actions: t.actions,
                steps: t.steps,
                challenge: t.challenge,
                standardId: null,
                standardVersion: null,
              },
            ],
            sources: [],
          }
        : await (agent || new DshAgent(cfg)).run(job, context);
    // Exercise the actual application domain settlement in memory, without its database.
    const settled = settleJob(created.state, job, output, []);
    const route = settled.result;
    result = {
      plan: null,
      currentRoute: route,
      projection: {
        schemaVersion: "earth.preview.v1",
        goalState: "draft",
        xpGranted: 0,
        skillsMastered: 0,
        nodes: route.stages.map((s, i) => ({
          id: `stage-${i}`,
          name: s.name,
          description: s.exercise,
          criterion: s.criterion,
          stat: route.stat,
          prerequisites: i ? [`stage-${i - 1}`] : [],
          status: i ? "locked" : "available",
        })),
        edges: route.stages
          .slice(1)
          .map((_, i) => ({ from: `stage-${i}`, to: `stage-${i + 1}` })),
        tasks: route.stages.slice(0, 1).map((s) => ({
          id: "current-stage-task",
          name: s.exercise,
          skillIds: ["stage-0"],
          minutes: s.actions.reduce((n, a) => n + a.minutes, 0),
          actions: s.actions,
          steps: s.steps,
          criterion: s.criterion,
          challenge: s.challenge,
          status: "proposed",
        })),
        topologicalOrder: route.stages.map((_, i) => `stage-${i}`),
      },
      warnings: [
        "现有阶段按线性依赖显示，不代表 Agent 生成了分支技能树。",
        "现有路线仅执行原项目校验；证据方式的语义适配仍需人工审阅。",
      ],
    };
  }
  return {
    requestId: id,
    mode: input.mode,
    engine: input.engine,
    model: input.mode === "live" ? cfg.DSH_MODEL : null,
    elapsedMs: Date.now() - start,
    input,
    ...result,
    retrieval: retrievalSummary(context.knowledge),
    checks: {
      json: true,
      schema: true,
      semantics:
        input.engine === "skills" ? "graph-and-budget" : "existing-domain",
    },
    writes: { productionDatabase: false, experience: false, mastery: false },
    warnings: [
      ...(result.warnings || []),
      "结构校验通过不代表任务内容或能力标准已被专业验证。",
    ],
  };
}
