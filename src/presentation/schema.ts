import { z } from "zod";

export const miaActionIdSchema = z.enum([
  "image_analyze",
  "image_edit",
  "image_to_video",
  "image_extract_text",
  "show_sources",
  "expand",
  "simplify",
]);

const titleSchema = z.object({
  text: z.string().trim().min(1).max(200),
  emoji: z.string().trim().max(16).nullable(),
}).strict();

const itemSchema = z.object({
  label: z.string().trim().min(1).max(120).nullable(),
  text: z.string().trim().min(1),
}).strict();

const standardBlockSchema = z.object({
  type: z.enum(["paragraph", "list", "facts", "code", "quote", "details"]),
  heading: z.string().trim().min(1).max(160).nullable(),
  emoji: z.string().trim().max(16).nullable(),
  text: z.string().trim().min(1).nullable(),
  items: z.array(itemSchema),
  ordered: z.boolean(),
  language: z.string().trim().max(40).nullable(),
}).strict();

const tableBlockSchema = z.object({
  type: z.literal("table"),
  heading: z.string().trim().min(1).max(160).nullable(),
  emoji: z.string().trim().max(16).nullable(),
  columns: z.array(z.string().trim().min(1).max(120)).min(2).max(8),
  rows: z.array(z.array(z.string().trim().max(1000)).min(2).max(8)).min(1).max(20),
  compact: z.boolean(),
}).strict();

export const miaResponseBlockSchema = z.discriminatedUnion("type", [standardBlockSchema, tableBlockSchema]);

export const miaResponseSchema = z.object({
  version: z.literal(1),
  title: titleSchema.nullable(),
  blocks: z.array(miaResponseBlockSchema).min(1),
  actions: z.array(miaActionIdSchema).max(4),
}).strict();

export type MiaActionId = z.infer<typeof miaActionIdSchema>;
export type MiaResponseBlock = z.infer<typeof miaResponseBlockSchema>;
export type MiaResponse = z.infer<typeof miaResponseSchema>;

export const MIA_RESPONSE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["version", "title", "blocks", "actions"],
  properties: {
    version: { type: "integer", enum: [1] },
    title: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["text", "emoji"],
          properties: {
            text: { type: "string", minLength: 1, maxLength: 200 },
            emoji: { type: ["string", "null"], maxLength: 16 },
          },
        },
      ],
    },
    blocks: {
      type: "array",
      minItems: 1,
      items: {
        anyOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["type", "heading", "emoji", "text", "items", "ordered", "language"],
            properties: {
              type: { type: "string", enum: ["paragraph", "list", "facts", "code", "quote", "details"] },
              heading: { type: ["string", "null"], maxLength: 160 },
              emoji: { type: ["string", "null"], maxLength: 16 },
              text: { type: ["string", "null"] },
              items: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["label", "text"],
                  properties: {
                    label: { type: ["string", "null"], maxLength: 120 },
                    text: { type: "string", minLength: 1 },
                  },
                },
              },
              ordered: { type: "boolean" },
              language: { type: ["string", "null"], maxLength: 40 },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["type", "heading", "emoji", "columns", "rows", "compact"],
            properties: {
              type: { type: "string", enum: ["table"] },
              heading: { type: ["string", "null"], maxLength: 160 },
              emoji: { type: ["string", "null"], maxLength: 16 },
              columns: {
                type: "array", minItems: 2, maxItems: 8,
                items: { type: "string", minLength: 1, maxLength: 120 },
              },
              rows: {
                type: "array", minItems: 1, maxItems: 20,
                items: {
                  type: "array", minItems: 2, maxItems: 8,
                  items: { type: "string", maxLength: 1000 },
                },
              },
              compact: { type: "boolean" },
            },
          },
        ],
      },
    },
    actions: { type: "array", maxItems: 4, items: { type: "string", enum: miaActionIdSchema.options } },
  },
} as const;

function cleanInline(value: string): string {
  return value.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/__([^_]+)__/g, "$1").trim();
}

export function normalizeMiaResponse(value: MiaResponse): MiaResponse {
  const blocks = value.blocks.flatMap((block): MiaResponseBlock[] => {
    if (block.type === "table") {
      const columns = block.columns.map(cleanInline).filter(Boolean);
      if (columns.length < 2) return [];
      const rows = block.rows
        .map((row) => columns.map((_, index) => cleanInline(row[index] ?? "")))
        .filter((row) => row.some(Boolean));
      if (rows.length === 0) return [];
      return [{
        ...block,
        heading: block.heading ? cleanInline(block.heading) : null,
        columns,
        rows,
      }];
    }
    const heading = block.heading ? cleanInline(block.heading) : null;
    const items = block.items
      .map((item) => ({ label: item.label ? cleanInline(item.label) : null, text: cleanInline(item.text) }))
      .filter((item) => item.text.length > 0);
    const recoveredText = items
      .map((item) => item.label ? `${item.label}：${item.text}` : item.text)
      .join("\n");
    const text = block.text ? cleanInline(block.text)
      : block.type === "paragraph" && recoveredText ? recoveredText
        : null;
    if ((block.type === "paragraph" || block.type === "code" || block.type === "quote" || block.type === "details") && !text) return [];
    if ((block.type === "list" || block.type === "facts") && items.length === 0) return [];
    return [{
      ...block,
      heading,
      text,
      items: block.type === "list" || block.type === "facts" ? items : [],
    }];
  });
  return {
    version: 1,
    title: value.title ? { text: cleanInline(value.title.text), emoji: value.title.emoji } : null,
    blocks: blocks.length > 0 ? blocks : [{
      type: "paragraph", heading: null, emoji: null, text: "...", items: [], ordered: false, language: null,
    }],
    actions: [...new Set(value.actions)],
  };
}

export function miaResponseFromText(text: string): MiaResponse {
  return {
    version: 1,
    title: null,
    blocks: [{
      type: "paragraph",
      heading: null,
      emoji: null,
      text: cleanInline(text),
      items: [],
      ordered: false,
      language: null,
    }],
    actions: [],
  };
}

export function miaResponsePlainText(value: MiaResponse): string {
  const response = normalizeMiaResponse(value);
  const parts: string[] = [];
  if (response.title) parts.push([response.title.emoji, response.title.text].filter(Boolean).join(" "));
  for (const block of response.blocks) {
    const lines: string[] = [];
    if (block.heading) lines.push([block.emoji, block.heading].filter(Boolean).join(" "));
    if (block.type === "table") {
      lines.push(block.columns.join(" | "));
      for (const row of block.rows) lines.push(row.join(" | "));
      parts.push(lines.join("\n"));
      continue;
    }
    if (block.text) lines.push(block.text);
    block.items.forEach((item, index) => {
      const prefix = block.type === "list" ? (block.ordered ? `${index + 1}.` : "●") : "";
      const body = item.label ? `${item.label}：${item.text}` : item.text;
      lines.push([prefix, body].filter(Boolean).join(" "));
    });
    if (lines.length > 0) parts.push(lines.join("\n"));
  }
  return parts.join("\n\n");
}
