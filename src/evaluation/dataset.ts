import { z } from "zod";

import { TOPIC_KEYS } from "../taxonomy/labels";

const action = z.object({ ambiguous: z.boolean(), value: z.boolean().nullable() });
export const datasetSchema = z
  .object({
    examples: z
      .array(
        z.object({
          body: z.string(),
          from: z.string().optional(),
          groundTruth: z.object({
            needs_reply: action,
            to_do: action,
            topic: z.object({
              ambiguous: z.boolean(),
              value: z.enum([...TOPIC_KEYS, "other"]).nullable(),
            }),
            urgent: action,
          }),
          id: z.string().min(1),
          subject: z.string(),
          templateGroup: z.string().optional(),
          threadId: z.string().optional(),
        })
      )
      .min(1)
      .max(5000),
    split: z.enum(["synthetic", "development", "held_out"]).default("synthetic"),
    version: z.string().min(1),
  })
  .refine(
    (data) =>
      new Set(data.examples.map((example) => example.id)).size === data.examples.length,
    { error: "Example IDs must be unique" }
  );

export interface EvaluationSettings {
  dataset: unknown;
  maxCalls: number;
  enforce: boolean;
  gatewayId: string;
}

const keys = (example: z.infer<typeof datasetSchema>["examples"][number]) => [
  `id:${example.id}`,
  ...(example.threadId ? [`thread:${example.threadId}`] : []),
  ...(example.templateGroup ? [`template:${example.templateGroup}`] : []),
  `content:${example.subject}\n${example.body}`,
];

export const validateHeldOutSplit = (development: unknown, heldOut: unknown): void => {
  const dev = datasetSchema.parse(development);
  const held = datasetSchema.parse(heldOut);
  if (dev.split !== "development" || held.split !== "held_out") {
    throw new Error("Evaluation requires development and held_out split markers");
  }
  const seen = new Set(dev.examples.flatMap(keys));
  if (held.examples.some((example) => keys(example).some((key) => seen.has(key)))) {
    throw new Error("Development and held-out datasets overlap");
  }
};
