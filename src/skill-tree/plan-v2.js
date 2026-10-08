import { z } from "zod";
import { ContractError } from "./contract.js";
const text = (n = 1000) => z.string().trim().min(1).max(n),
  id = z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/);
export const nodeSchemaV2 = z
  .object({
    id,
    name: text(100),
    description: text(800),
    icon: z.enum([
      "core",
      "vocabulary",
      "listening",
      "reading",
      "writing",
      "speaking",
      "grammar",
      "milestone",
      "practice",
      "knowledge",
    ]),
    kind: z.enum(["core", "domain", "ability", "milestone"]),
    parentId: id.nullable(),
    prerequisites: z.array(id).max(8),
    baseline: z
      .object({
        status: z.enum(["lit", "unlit"]),
        basis: z.enum(["self_report", "unknown"]),
        quote: z.string().max(600).nullable(),
      })
      .strict()
      .default({ status: "unlit", basis: "unknown", quote: null }),
    stat: z.number().int().min(0).max(4),
    milestone: z
      .object({ framework: text(80), label: text(80) })
      .strict()
      .nullable(),
  })
  .strict();
export const resourceSchemaV2 = z
  .object({
    id,
    name: text(150),
    kind: z.enum([
      "app",
      "book",
      "questions",
      "website",
      "user_material",
      "self_created",
    ]),
    availability: z.enum([
      "verified_link",
      "user_provided",
      "needs_user",
      "self_created",
    ]),
    url: z.url().nullable(),
    locator: text(800),
    purpose: text(600),
    question: z.string().max(500).nullable(),
  })
  .strict();
export const taskSchemaV2 = z
  .object({
    id,
    name: text(150),
    skillIds: z.array(id).min(1).max(6),
    minutes: z.number().int().min(1).max(360),
    stat: z.number().int().min(0).max(4),
    purpose: text(600),
    resourceIds: z.array(id).max(6),
    readiness: z.enum(["ready", "needs_material"]),
    materialQuestion: z.string().max(500).nullable(),
    actions: z
      .array(
        z
          .object({
            name: text(180),
            minutes: z.number().int().min(1).max(360),
            detail: text(1800),
          })
          .strict(),
      )
      .min(1)
      .max(8),
  })
  .strict();
export const planSchemaV2 = z
  .object({
    schemaVersion: z.literal("earth.plan.v2"),
    goal: z
      .object({
        title: text(150),
        target: text(800),
        minutes: z.number().int().min(1).max(360),
      })
      .strict(),
    summary: text(1200),
    assumptions: z.array(text(600)).max(12),
    coreSkillId: id,
    skills: z.array(nodeSchemaV2).min(3).max(24),
    targetSkillIds: z.array(id).min(1).max(8),
    strategy: z
      .array(
        z
          .object({
            name: text(100),
            skillIds: z.array(id).min(1).max(8),
            approach: text(1200),
            timing: text(300),
          })
          .strict(),
      )
      .min(1)
      .max(8),
    resources: z.array(resourceSchemaV2).max(15),
    tasks: z.array(taskSchemaV2).min(1).max(8),
  })
  .strict();
export function parsePlanV2(
  raw,
  { personal = false, nodeSchema = nodeSchemaV2 } = {},
) {
  const schema = personal
    ? planSchemaV2.extend({ skills: z.array(nodeSchema).min(3).max(500) })
    : planSchemaV2;
  const plan = schema.parse(raw),
    issues = [],
    issue = (path, code) => issues.push({ path, code });
  const nodes = new Map(),
    resources = new Map();
  for (const [i, n] of plan.skills.entries()) {
    if (nodes.has(n.id)) issue(["skills", i], "duplicate_id");
    nodes.set(n.id, n);
    if ((n.kind === "milestone") !== !!n.milestone)
      issue(["skills", i], "milestone_label_required");
  }
  const core = nodes.get(plan.coreSkillId);
  if (
    !core ||
    core.kind !== "core" ||
    core.parentId !== null ||
    plan.skills.filter((n) => n.kind === "core").length !== 1
  )
    issue(["coreSkillId"], "single_core_required");
  for (const n of plan.skills) {
    if (n.id !== plan.coreSkillId && !nodes.has(n.parentId))
      issue(["skills", n.id], "missing_parent");
    let current = n,
      seen = new Set();
    while (current && current.id !== plan.coreSkillId) {
      if (seen.has(current.id)) {
        issue(["skills", n.id], "parent_cycle");
        break;
      }
      seen.add(current.id);
      current = nodes.get(current.parentId);
    }
    if (!current) issue(["skills", n.id], "disconnected_node");
    for (const p of n.prerequisites)
      if (!nodes.has(p)) issue(["skills", n.id], "missing_prerequisite");
  }
  const active = new Set(),
    done = new Set(),
    order = [];
  function visit(id) {
    if (active.has(id)) {
      issue(["skills", id], "dependency_cycle");
      return;
    }
    if (done.has(id) || !nodes.has(id)) return;
    active.add(id);
    nodes.get(id).prerequisites.forEach(visit);
    active.delete(id);
    done.add(id);
    order.push(id);
  }
  nodes.forEach((n) => visit(n.id));
  for (const id of plan.targetSkillIds)
    if (!nodes.has(id)) issue(["targetSkillIds"], "missing_reference");
  for (const s of plan.strategy)
    for (const id of s.skillIds)
      if (!nodes.has(id)) issue(["strategy"], "missing_reference");
  for (const r of plan.resources) {
    if (resources.has(r.id)) issue(["resources", r.id], "duplicate_id");
    resources.set(r.id, r);
    if (r.url && !/^https?:\/\//.test(r.url))
      issue(["resources", r.id], "unsafe_url");
    if (r.availability === "verified_link" && !r.url)
      issue(["resources", r.id], "url_required");
    if (r.availability === "needs_user" && !r.question?.trim())
      issue(["resources", r.id], "material_question_required");
  }
  const ids = new Set();
  for (const t of plan.tasks) {
    if (ids.has(t.id)) issue(["tasks", t.id], "duplicate_id");
    ids.add(t.id);
    for (const id of t.skillIds)
      if (!nodes.has(id)) issue(["tasks", t.id], "missing_skill");
    for (const id of t.resourceIds)
      if (!resources.has(id)) issue(["tasks", t.id], "missing_resource");
    if (t.actions.reduce((n, a) => n + a.minutes, 0) !== t.minutes)
      issue(["tasks", t.id], "duration_mismatch");
    if (t.readiness === "needs_material" && !t.materialQuestion?.trim())
      issue(["tasks", t.id], "material_question_required");
    if (
      t.readiness === "ready" &&
      t.resourceIds.some(
        (id) => resources.get(id)?.availability === "needs_user",
      )
    )
      issue(["tasks", t.id], "unavailable_material");
  }
  if (plan.tasks.reduce((n, t) => n + t.minutes, 0) > plan.goal.minutes)
    issue(["tasks"], "budget_exceeded");
  if (issues.length) throw new ContractError("invalid_semantics", issues);
  return {
    plan,
    projection: {
      schemaVersion: "earth.preview.v2",
      coreSkillId: plan.coreSkillId,
      nodes: plan.skills,
      edges: plan.skills
        .filter((n) => n.parentId)
        .map((n) => ({ from: n.parentId, to: n.id })),
      topologicalOrder: order,
      tasks: plan.tasks,
      goalState: "draft",
      xpGranted: 0,
    },
  };
}
export function checkResources(result, verifiedUrls) {
  for (const r of result.plan?.resources ?? [])
    if (r.availability === "verified_link" && !verifiedUrls.includes(r.url))
      throw new ContractError("invalid_semantics", [
        { path: ["resources", r.id], code: "unverified_resource_url" },
      ]);
  return result;
}
