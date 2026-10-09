import { ContractError } from "./contract.js";
import { analyzeIntent, isRetryMessage } from "../../src/intent.js";
export const isRetry = isRetryMessage;
export const conversationIntent = (c) =>
  analyzeIntent(
    { kind: "workbench", input: {} },
    {
      messages: c.messages,
      plans: (c.plan?.tasks ?? []).map((t) => ({ ...t, status: "planned" })),
      lastQuestions:
        c.messages.findLast((m) => m.role === "assistant")?.result?.questions ??
        [],
    },
  );
export function intakeState(c) {
  const intent = conversationIntent(c);
  const conversational = ["greeting", "question", "reflection", "goal_change"];
  const substantive = (m) =>
    m.role === "user" &&
    !isRetry(m.content) &&
    m.turnType !== "background" &&
    !conversational.includes(conversationIntent({ messages: [m] }).kind);
  let startIndex = c.intake?.startIndex ?? 0,
    finalized = !!c.intake?.finalized;
  const lastAssistant = c.messages.findLastIndex((m) => m.role === "assistant");
  const processedThrough =
    c.intake?.processedThrough ??
    (lastAssistant >= 0 ? lastAssistant : c.messages.length - 1);
  if (finalized) {
    const next = c.messages.findIndex(
      (m, i) => i > processedThrough && substantive(m),
    );
    if (next >= 0 && intent.kind !== "schedule_change") {
      startIndex = next;
      finalized = false;
    }
  }
  const rounds = Math.min(
    5,
    c.messages.slice(startIndex).filter(substantive).length,
  );
  const scoped = c.messages
    .slice(startIndex)
    .filter((m) => m.role === "user")
    .map((m) => m.content)
    .join("\n");
  const ready =
    intent.explicitPlanning &&
    (/(?:直接|现在|不再|别再|不要再).{0,10}(?:安排|规划|生成|追问)/.test(
      scoped,
    ) ||
      (/(?:基础|能|会|水平)/.test(scoped) && /(?:分钟|小时)/.test(scoped)));
  return {
    startIndex,
    round: rounds,
    maxRounds: 5,
    mustPlan:
      !conversational.includes(intent.kind) &&
      (rounds >= 5 || finalized || ready),
    finalized,
    backgroundUsed: c.messages.some(
      (m) => m.role === "user" && m.turnType === "background",
    ),
  };
}
export function compactContext(c) {
  const intake = intakeState(c);
  const users = c.messages
    .slice(intake.startIndex)
    .filter((m) => m.role === "user" && !isRetry(m.content));
  const selected = [...new Set([...users.slice(0, 5), ...users.slice(-8)])];
  const last = [...c.messages].reverse().find((m) => m.result)?.result;
  const p = c.plan;
  return {
    userStatements: selected.map((m) => m.content),
    messages: c.messages
      .slice(-4)
      .map((m) => ({
        role: m.role,
        content: m.role === "assistant" ? m.content.slice(0, 220) : m.content,
      })),
    intent: conversationIntent({
      ...c,
      messages: c.messages.slice(intake.startIndex),
    }),
    knownFacts:
      intake.startIndex > 0 && !intake.finalized
        ? []
        : (last?.understanding?.knownFacts ?? []),
    lastQuestions: last?.questions ?? [],
    previousPlan: p
      ? {
          schemaVersion: p.schemaVersion,
          goal: p.goal,
          coreSkillId: p.coreSkillId,
          skills: (p.skills ?? []).map((n) => ({
            id: n.id,
            name: n.name,
            kind: n.kind,
            parentId: n.parentId,
            prerequisites: n.prerequisites,
            baseline: n.baseline,
          })),
          targetSkillIds: p.targetSkillIds,
          strategy: p.strategy,
          resources: p.resources,
          tasks: p.tasks.map((t) => ({
            id: t.id,
            name: t.name,
            minutes: t.minutes,
            skillIds: t.skillIds,
            purpose: t.purpose,
          })),
        }
      : null,
    revision: c.revision,
    intake,
    standards: [],
    profile: {},
    goals: [],
    plans: [],
    records: [],
  };
}
export function enforceIntake(output, intake, intent) {
  if (intent?.requiresClarification && output.plan)
    throw new ContractError("invalid_semantics", [
      { path: ["plan"], code: "ambiguous_intent_requires_clarification" },
    ]);
  if (
    intent &&
    (["greeting", "question", "reflection"].includes(intent.kind) ||
      intent.blockedActions.includes("plan")) &&
    output.plan
  )
    throw new ContractError("invalid_semantics", [
      { path: ["plan"], code: "informational_intent_has_no_plan" },
    ]);
  if (intake.mustPlan && !output.plan)
    throw new ContractError("invalid_semantics", [
      { path: ["plan"], code: "intake_limit_requires_plan" },
    ]);
  if (intake.mustPlan) output.questions = [];
  else if (output.questions.length > 2)
    throw new ContractError("invalid_semantics", [
      { path: ["questions"], code: "only_two_priority_questions" },
    ]);
  return output;
}
export function verifyBaselines(output, c) {
  const statements = c.messages
    .filter((m) => m.role === "user" && !isRetry(m.content))
    .map((m) => m.content);
  for (const n of output.plan?.skills ?? []) {
    const b = n.baseline;
    if (
      b?.status === "lit" &&
      (!b.quote?.trim() ||
        b.basis !== "self_report" ||
        !statements.some((s) => s.includes(b.quote)))
    )
      throw new ContractError("invalid_semantics", [
        {
          path: ["skills", n.id, "baseline"],
          code: "baseline_requires_user_quote",
        },
      ]);
  }
  return output;
}
export function failureSummary(e) {
  return {
    code:
      e.code ??
      e.failure?.code ??
      (e.name === "ZodError" ? "output_schema_invalid" : "internal_error"),
    ...(e.failure?.execution ? { execution: e.failure.execution } : {}),
    ...(e.failure?.phase ? { phase: e.failure.phase } : {}),
    ...(e.failure?.json ? { json: e.failure.json } : {}),
    issues: (e.issues ?? [])
      .slice(0, 8)
      .map((i) => ({ path: i.path, code: i.code })),
  };
}
export const recoverable = new Set([
  "invalid_semantics",
  "output_schema_invalid",
  "output_json_invalid",
  "model_timeout",
  "model_execution_failed",
  "model_output_empty",
  "model_output_limit",
]);
