import { z } from "zod";
const text = (n = 1000) => z.string().trim().min(1).max(n);
export const uuid = z.uuid();
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const actionBlock = z
  .object({
    name: text(200),
    minutes: z.number().int().min(1).max(1440),
  })
  .strict();
export const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (s) =>
      !Number.isNaN(Date.parse(s)) &&
      new Date(s).toISOString().slice(0, 10) === s,
    "日期无效",
  );
export const stageSchema = z
  .object({
    name: text(120),
    criterion: text(1000),
    exercise: text(200),
    actions: z
      .array(actionBlock.extend({ minutes: z.number().int().min(1).max(240) }))
      .max(12)
      .default([])
      .describe(
        "可直接安排进一天的具体行动块；name 简短明确，minutes 表示时长，每阶段总时长不得超过路线 minutes。",
      ),
    steps: text(2000).describe(
      "练习步骤，用一段字符串表达；多步之间可用换行分隔。",
    ),
    challenge: text(1500),
    standardId: text(100).nullable().default(null),
    standardVersion: z.number().int().positive().nullable().default(null),
  })
  .strict();
export const sourceSchema = z
  .object({
    title: text(200),
    url: z.url().refine((v) => /^https?:\/\//.test(v)),
    note: text(500),
    retrievedAt: z.iso.datetime().optional(),
  })
  .strict();
export const routeSchema = z
  .object({
    summary: text(2000),
    minutes: z.number().int().min(5).max(240),
    stat: z.number().int().min(0).max(4),
    stages: z.array(stageSchema).min(1).max(8),
    sources: z.array(sourceSchema).max(15).default([]),
  })
  .strict();
export const assessmentSchema = z
  .object({
    outcome: z.enum(["passed", "not_passed", "insufficient"]),
    feedback: text(4000),
    quotes: z.array(text(1000)).max(10),
    evidenceType: z.enum(["text", "self_report", "external_unverified"]),
    standardId: text(100).nullable(),
    standardVersion: z.number().int().positive().nullable(),
  })
  .strict();
export const commandSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("profile.update"),
    name: text(30),
    daily: z.number().int().min(5).max(1440),
    timezone: text(100),
    preferences: z.string().max(2000).default(""),
  }),
  z.object({
    type: z.literal("goal.create"),
    title: text(120),
    base: text(1000),
    minutes: z.number().int().min(5).max(240),
    criterion: text(1500),
    requiresExternal: z.boolean().default(false),
    kind: z.enum(["main", "side"]).default("main"),
  }),
  z.object({ type: z.literal("goal.confirm"), id: uuid, draftId: uuid }),
  z.object({ type: z.literal("goal.delete"), id: uuid }),
  z.object({ type: z.literal("goal.restore"), id: uuid }),
  z.object({
    type: z.literal("goal.status"),
    id: uuid,
    status: z.enum(["active", "paused", "ended"]),
  }),
  z.object({
    type: z.literal("goal.adjust"),
    id: uuid,
    reason: text(1500),
    minutes: z.number().int().min(5).max(240),
  }),
  z.object({
    type: z.literal("plan.create"),
    goal: uuid.nullable(),
    name: text(200),
    minutes: z.number().int().min(1).max(1440),
    day: date,
    time,
    stat: z.number().int().min(0).max(4),
  }),
  z.object({
    type: z.literal("plan.update"),
    id: uuid,
    name: text(200),
    minutes: z.number().int().min(1).max(1440),
    day: date,
    time,
  }),
  z.object({
    type: z.literal("plan.batch"),
    goal: uuid,
    stage: z.number().int().nonnegative(),
    revision: z.number().int().positive(),
    day: date,
    time,
    blocks: z.array(actionBlock).min(1).max(24),
  }),
  z.object({
    type: z.literal("plan.status"),
    id: uuid,
    status: z.enum(["planned", "paused", "cancelled"]),
  }),
  z.object({
    type: z.literal("action.record"),
    plan: uuid.nullable(),
    goal: uuid.nullable(),
    name: text(200),
    minutes: z.number().int().min(0).max(1440),
    day: date,
    stat: z.number().int().min(0).max(4),
    note: z.string().max(3000),
    completion: z.enum(["done", "partial", "rest"]),
  }),
  z.object({
    type: z.literal("submission.create"),
    goal: uuid,
    content: text(12000),
    kind: z.enum(["practice", "challenge"]),
    helpUsed: z.boolean().default(false),
  }),
  z.object({ type: z.literal("submission.retry"), id: uuid }),
  z.object({ type: z.literal("memory.correct"), id: uuid, body: text(4000) }),
  z.object({ type: z.literal("memory.delete"), id: uuid }),
  z.object({ type: z.literal("review.create"), day: date }),
  z.object({ type: z.literal("chat.send"), content: text(5000) }),
  z.object({
    type: z.literal("event.create"),
    externalId: text(200),
    content: text(3000),
    occurredAt: z.iso.datetime(),
    kind: z.enum(["completed", "opportunity", "note"]),
    claimBy: z.iso.datetime().optional(),
    executeBy: z.iso.datetime().optional(),
  }),
  z.object({ type: z.literal("event.claim"), id: uuid }),
  z.object({ type: z.literal("event.complete"), id: uuid, note: text(3000) }),
  z.object({ type: z.literal("goal.external"), id: uuid, content: text(6000) }),
  z.object({
    type: z.literal("practice.grade"),
    standardId: text(100),
    standardVersion: z.number().int().positive(),
    questionId: text(100),
    choiceId: text(100),
  }),
  z.object({
    type: z.literal("standard.propose"),
    name: text(200),
    scope: text(2000),
    criteria: text(3000),
  }),
]);
export const guidanceSchema = z
  .object({
    title: text(120),
    summary: text(300),
    sources: z.array(sourceSchema).max(6).optional(),
    steps: z
      .array(
        z
          .object({
            title: text(120),
            minutes: z.number().int().min(1).max(240),
            kind: z.enum(["main", "side", "free"]),
            detail: text(300).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(6),
  })
  .strict();
export const chatSchema = z
  .object({
    reply: text(10000),
    guidance: guidanceSchema.nullable().default(null),
    proposals: z
      .array(z.object({ label: text(100), command: commandSchema }).strict())
      .max(3)
      .default([]),
  })
  .strict();
export const reviewSchema = z.object({ summary: text(6000) }).strict();
// The model instructions and the runtime validator consume the same contracts.
export const outputSchemas = Object.freeze({
  route: routeSchema,
  assessment: assessmentSchema,
  chat: chatSchema,
  review: reviewSchema,
});
export const credentialsSchema = z
  .object({
    email: z
      .email()
      .max(254)
      .transform((s) => s.toLowerCase()),
    password: z.string().min(12).max(128),
  })
  .strict();
export const envelopeSchema = z
  .object({
    expectedVersion: z.number().int().nonnegative(),
    command: commandSchema,
  })
  .strict();
