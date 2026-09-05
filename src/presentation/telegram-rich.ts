import type { InputRichBlock, InputRichMessage, RichText } from "grammy/types";

import { miaResponsePlainText, normalizeMiaResponse, type MiaResponse, type MiaResponseBlock } from "./schema.js";
import { renderTelegramHtml, type TelegramPresentationChunk } from "./telegram-html.js";

const RICH_TEXT_TARGET_BYTES = 28_000;
const RICH_UNIT_TARGET_BYTES = 22_000;

export interface TelegramRichPresentationChunk {
  richMessage: InputRichMessage;
  richBlocks: InputRichBlock[];
  plainText: string;
  htmlFallback: TelegramPresentationChunk[];
}

function displayHeading(emoji: string | null, heading: string): string {
  return [emoji, heading].filter(Boolean).join(" ");
}

function labeledText(label: string | null, text: string): RichText {
  return label ? [{ type: "bold", text: label }, "：", text] : text;
}

function tableText(text: string): RichText {
  const parts: RichText[] = [];
  const pattern = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;
  let offset = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index;
    const label = match[1];
    const url = match[2];
    if (index > offset) parts.push(text.slice(offset, index));
    if (label && url) parts.push({ type: "url", text: label, url });
    offset = index + match[0].length;
  }
  if (offset < text.length) parts.push(text.slice(offset));
  return parts.length === 0 ? text : parts.length === 1 ? parts[0] ?? text : parts;
}

function tableCell(text: string, header = false) {
  return {
    text: tableText(text),
    ...(header ? { is_header: true as const } : {}),
    align: "left" as const,
    valign: "middle" as const,
  };
}

function blockToRich(block: MiaResponseBlock): InputRichBlock[] {
  const result: InputRichBlock[] = [];
  if (block.type === "details") {
    result.push({
      type: "details",
      summary: displayHeading(block.emoji, block.heading ?? "…"),
      blocks: [{ type: "paragraph", text: block.text ?? "" }],
    });
    return result;
  }
  if (block.heading) {
    result.push({ type: "heading", size: 3, text: displayHeading(block.emoji, block.heading) });
  }
  if (block.type === "table") {
    result.push({
      type: "table",
      cells: [
        block.columns.map((column) => tableCell(column, true)),
        ...block.rows.map((row) => block.columns.map((_, index) => tableCell(row[index] ?? ""))),
      ],
      is_bordered: true,
      is_striped: true,
      ...(block.compact ? { is_compact: true as const } : {}),
    });
  } else if (block.type === "paragraph") {
    result.push({ type: "paragraph", text: block.text ?? "" });
  } else if (block.type === "code") {
    result.push({
      type: "pre",
      text: block.text ?? "",
      ...(block.language ? { language: block.language } : {}),
    });
  } else if (block.type === "quote") {
    result.push({ type: "blockquote", blocks: [{ type: "paragraph", text: block.text ?? "" }] });
  } else if (block.type === "list") {
    result.push({
      type: "list",
      items: block.items.map((item, index) => ({
        label: block.ordered ? `${index + 1}.` : "•",
        ...(block.ordered ? { value: index + 1, type: "1" as const } : {}),
        blocks: [{ type: "paragraph", text: labeledText(item.label, item.text) }],
      })),
    });
  } else if (block.type === "facts") {
    result.push({
      type: "table",
      cells: block.items.map((item) => [
        tableCell(item.label ?? "", item.label !== null),
        tableCell(item.text),
      ]),
      is_bordered: true,
      is_striped: true,
      is_compact: true,
    });
  }
  return result;
}

function asResponse(title: MiaResponse["title"], blocks: MiaResponseBlock[]): MiaResponse {
  return { version: 1, title, blocks, actions: [] };
}

function responseBytes(response: MiaResponse): number {
  return Buffer.byteLength(miaResponsePlainText(response), "utf8");
}

function splitCollectionBlock(block: MiaResponseBlock): MiaResponseBlock[] {
  if (block.type !== "list" && block.type !== "facts" && block.type !== "table") return [block];
  const entries = block.type === "table" ? block.rows : block.items;
  const result: MiaResponseBlock[] = [];
  let current: typeof entries = [];
  for (const entry of entries) {
    const candidate = [...current, entry] as typeof entries;
    const candidateBlock = block.type === "table"
      ? { ...block, rows: candidate as typeof block.rows }
      : { ...block, items: candidate as typeof block.items };
    if (current.length > 0 && responseBytes(asResponse(null, [candidateBlock])) > RICH_UNIT_TARGET_BYTES) {
      result.push(block.type === "table"
        ? { ...block, rows: current as typeof block.rows }
        : { ...block, items: current as typeof block.items });
      current = [entry] as typeof entries;
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) {
    const continuation = result.length > 0 ? { heading: null, emoji: null } : {};
    result.push(block.type === "table"
      ? { ...block, ...continuation, rows: current as typeof block.rows }
      : { ...block, ...continuation, items: current as typeof block.items });
  }
  return result;
}

function richBlocks(response: MiaResponse): InputRichBlock[] {
  const blocks: InputRichBlock[] = [];
  if (response.title) {
    blocks.push({ type: "heading", size: 2, text: displayHeading(response.title.emoji, response.title.text) });
  }
  for (const block of response.blocks) blocks.push(...blockToRich(block));
  return blocks;
}

function presentationChunk(response: MiaResponse): TelegramRichPresentationChunk {
  const blocks = richBlocks(response);
  return {
    richMessage: { blocks },
    richBlocks: blocks,
    plainText: miaResponsePlainText(response),
    htmlFallback: renderTelegramHtml(response),
  };
}

export function renderTelegramRich(value: MiaResponse): TelegramRichPresentationChunk[] {
  const response = normalizeMiaResponse(value);
  const sourceBlocks = response.blocks.flatMap(splitCollectionBlock);
  const chunks: TelegramRichPresentationChunk[] = [];
  let currentBlocks: MiaResponseBlock[] = [];
  let currentTitle = response.title;

  for (const block of sourceBlocks) {
    const candidate = asResponse(currentTitle, [...currentBlocks, block]);
    if (currentBlocks.length > 0 && responseBytes(candidate) > RICH_TEXT_TARGET_BYTES) {
      chunks.push(presentationChunk(asResponse(currentTitle, currentBlocks)));
      currentBlocks = [block];
      currentTitle = null;
    } else {
      currentBlocks.push(block);
    }
  }
  if (currentBlocks.length > 0) chunks.push(presentationChunk(asResponse(currentTitle, currentBlocks)));
  return chunks;
}
