import { skillIconCatalog } from "../../public/skill-tree/skill-icons.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import { nodeSchemaV2, planSchemaV2, parsePlanV2 } from "./plan-v2.js";
import { ContractError } from "./contract.js";

const id = z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/);
const text = (n) => z.string().trim().min(1).max(n);
const icons = skillIconCatalog.map((i) => i.key);
export const personalNodeSchema = nodeSchemaV2.extend({ icon: z.enum(icons) });
export const addedNodeSchema = personalNodeSchema.extend({
  kind: z.enum(["domain", "ability"]),
  parentId: id,
  milestone: z.null(),
  icon: z.enum(icons.filter((i) => i !== "milestone" && i !== "core")),
  baseline: z.discriminatedUnion("status", [
    z
      .object({
        status: z.literal("unlit"),
        basis: z.literal("unknown"),
        quote: z.null(),
      })
      .strict(),
    z
      .object({
        status: z.literal("lit"),
        basis: z.literal("self_report"),
        quote: text(600),
      })
      .strict(),
  ]),
});
export const treePatchSchema = z
  .object({
    schemaVersion: z.literal("earth.tree.patch.v1"),
    baseRevision: z.number().int().nonnegative(),
    requestId: z.uuid(),
    goalId: id,
    addNodes: z.array(addedNodeSchema).max(8),
    reuseNodeIds: z.array(id).max(100),
    updateNodes: z
      .array(z.object({ id, description: text(800) }).strict())
      .max(20),
  })
  .strict();
export const planSchemaV3 = planSchemaV2
  .omit({ skills: true, coreSkillId: true })
  .extend({ schemaVersion: z.literal("earth.plan.v3") });
const skeleton = [
  ["self", null, "我", "core"],
  ["body", "self", "身心", "body"],
  ["mind", "self", "认知", "mind"],
  ["practice", "self", "实践", "action"],
  ["physical", "body", "体能", "body"],
  ["sport", "body", "运动技能", "sport"],
  ["emotion", "body", "情绪调节", "emotion"],
  ["attention", "body", "注意与行动", "focus"],
  ["language", "mind", "语言", "language"],
  ["learning", "mind", "学习方法", "knowledge"],
  ["logic", "mind", "逻辑推理", "logic"],
  ["knowledge", "mind", "知识理解", "knowledge"],
  ["information", "mind", "信息判断", "information"],
  ["communication", "practice", "沟通协作", "social"],
  ["life", "practice", "生活技能", "home"],
  ["finance", "practice", "财务管理", "money"],
  ["professional", "practice", "工作技术", "work"],
  ["art", "practice", "艺术创作", "art"],
];
export const fixedIds = new Set(skeleton.map((n) => n[0]));
export function initialTree() {
  return {
    schemaVersion: "earth.tree.v1",
    revision: 0,
    nodes: skeleton.map(([id, parentId, name, icon]) => ({
      id,
      parentId,
      name,
      icon,
      kind: id === "self" ? "core" : "domain",
      description: name + "领域入口",
      prerequisites: [],
      baseline: { status: "unlit", basis: "unknown", quote: null },
      stat: 0,
      milestone: null,
    })),
    goals: [],
    taskBatches: [],
    receipts: {},
  };
}
const fail = (code, path = []) => {
  throw new ContractError("invalid_semantics", [{ path, code }]);
};
const nameKey = (n) =>
  n.name
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\s\p{P}]/gu, "");

// Pure transaction: validate against a cloned tree. No caller-owned state is mutated.
export function applyTreePatch(
  tree,
  rawPatch,
  rawPlan,
  { userStatements = [], requestId } = {},
) {
  const patch = treePatchSchema.parse(rawPatch),
    plan = planSchemaV3.parse(rawPlan);
  if (requestId && patch.requestId !== requestId)
    fail("request_id_mismatch", ["treePatch", "requestId"]);
  const digest = createHash("sha256")
    .update(JSON.stringify({ patch, plan }))
    .digest("hex");
  const receipt = tree.receipts[patch.requestId];
  if (receipt) {
    if (receipt.digest !== digest) fail("idempotency_payload_changed");
    return {
      tree: structuredClone(tree),
      plan: structuredClone(receipt.plan),
      replayed: true,
    };
  }
  if (patch.baseRevision !== tree.revision)
    fail("stale_tree_revision", ["treePatch", "baseRevision"]);
  const next = structuredClone(tree),
    nodes = new Map(next.nodes.map((n) => [n.id, n]));
  const reuse = new Set(patch.reuseNodeIds);
  if (reuse.size !== patch.reuseNodeIds.length) fail("duplicate_reuse");
  for (const id of reuse)
    if (!nodes.has(id)) fail("missing_reused_node", ["reuseNodeIds", id]);
  const added = new Set();
  for (const n of patch.addNodes) {
    if (
      /里程碑|阶段|\d+(?:\.\d+)?\s*分|^(?:雅思|IELTS|托福|TOEFL)|(?:入门|初级|中级|高级|进阶|基础)阶段|^(?:完成|每天|每周|练习)\d/i.test(
        n.name,
      )
    )
      fail("skill_not_goal_or_stage", ["addNodes", n.id]);
    if (
      n.parentId === "language" &&
      ([
        "listening",
        "reading",
        "speaking",
        "writing",
        "grammar",
        "vocabulary",
      ].includes(n.icon) ||
        /^(?:英语)?(?:听力|阅读|口语|写作|语法|词汇)$/.test(n.name))
    )
      fail("language_skill_requires_language_parent", ["addNodes", n.id]);
    if (nodes.has(n.id)) fail("node_id_exists", ["addNodes", n.id]);
    if (
      n.baseline.status === "lit" &&
      (n.baseline.basis !== "self_report" ||
        !n.baseline.quote?.trim() ||
        !userStatements.some((s) => s.includes(n.baseline.quote)))
    )
      fail("baseline_requires_user_quote", ["addNodes", n.id]);
    if (
      n.baseline.status === "unlit" &&
      (n.baseline.basis !== "unknown" || n.baseline.quote !== null)
    )
      fail("inconsistent_baseline", ["addNodes", n.id]);
    nodes.set(n.id, n);
    added.add(n.id);
    next.nodes.push(n);
  }
  const touched = new Set();
  for (const change of patch.updateNodes) {
    if (touched.has(change.id)) fail("duplicate_update");
    touched.add(change.id);
    if (
      fixedIds.has(change.id) ||
      added.has(change.id) ||
      !reuse.has(change.id)
    )
      fail("protected_or_unreused_update", ["updateNodes", change.id]);
    nodes.get(change.id).description = change.description;
  }
  const names = new Set();
  for (const n of next.nodes) {
    const key = n.parentId + "|" + nameKey(n);
    if (names.has(key)) fail("duplicate_sibling_name", ["nodes", n.id]);
    names.add(key);
    if (
      n.id !== "self" &&
      n.parentId === "self" &&
      !["body", "mind", "practice"].includes(n.id)
    )
      fail("fixed_first_level", ["nodes", n.id]);
  }
  // A task may only use a node the Agent explicitly adds or reuses in this patch.
  for (const id of [
    ...plan.targetSkillIds,
    ...plan.strategy.flatMap((s) => s.skillIds),
    ...plan.tasks.flatMap((t) => t.skillIds),
  ]) {
    if (!added.has(id) && !reuse.has(id))
      fail("undeclared_skill_reference", ["plan", id]);
    if (fixedIds.has(id)) fail("concrete_skill_required", ["plan", id]);
  }
  if (next.nodes.length > 500) fail("tree_capacity_exceeded");
  const materialized = {
    ...plan,
    schemaVersion: "earth.plan.v2",
    coreSkillId: "self",
    skills: next.nodes.map((n) => personalNodeSchema.strip().parse(n)),
  };
  parsePlanV2(materialized, { personal: true, nodeSchema: personalNodeSchema });
  const goal = {
    id: patch.goalId,
    ...plan.goal,
    targetSkillIds: [
      ...new Set([
        ...plan.targetSkillIds,
        ...plan.strategy.flatMap((s) => s.skillIds),
        ...plan.tasks.flatMap((t) => t.skillIds),
      ]),
    ],
  };
  const goalIndex = next.goals.findIndex((g) => g.id === goal.id);
  if (goalIndex >= 0)
    next.goals[goalIndex] = { ...next.goals[goalIndex], ...goal };
  else next.goals.push(goal);
  next.revision++;
  next.taskBatches.push({
    requestId: patch.requestId,
    goalId: goal.id,
    revision: next.revision,
    tasks: plan.tasks,
    resources: plan.resources,
  });
  next.receipts[patch.requestId] = { digest, plan: materialized };
  return { tree: next, plan: materialized, replayed: false };
}
