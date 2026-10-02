import { z } from "zod";
const question = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
    prompt: z.string().min(1).max(2000),
    choices: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
            text: z.string().min(1).max(1000),
          })
          .strict(),
      )
      .min(2)
      .max(8),
    correctChoice: z.string().min(1),
    explanation: z.string().min(1).max(2000),
  })
  .strict()
  .refine(
    (q) =>
      new Set(q.choices.map((c) => c.id)).size === q.choices.length &&
      q.choices.some((c) => c.id === q.correctChoice),
    "Choices must be unique and include the answer",
  );
export const standardSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]{3,100}$/),
    version: z.number().int().positive(),
    name: z.string().min(1).max(200),
    scope: z.string().min(1).max(2000),
    criteria: z.string().min(1).max(3000),
    reviewedBy: z.string().min(1).max(200),
    sourceUrl: z.url(),
    questions: z.array(question).max(100).default([]),
  })
  .strict()
  .refine(
    (s) => new Set(s.questions.map((q) => q.id)).size === s.questions.length,
    "Question IDs must be unique",
  );
export function publicStandard(s) {
  return {
    ...s,
    body: {
      ...s.body,
      questions: (s.body.questions ?? []).map(
        ({ correctChoice, explanation, ...question }) => question,
      ),
    },
  };
}
