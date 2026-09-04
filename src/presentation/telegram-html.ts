import { TELEGRAM_MESSAGE_LIMIT } from "../constants.js";
import { miaResponsePlainText, normalizeMiaResponse, type MiaResponse } from "./schema.js";

export interface TelegramPresentationChunk {
  html: string;
  plainText: string;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function headingHtml(emoji: string | null, heading: string): string {
  return `${emoji ? `${escapeHtml(emoji)} ` : ""}<b>${escapeHtml(heading)}</b>`;
}

function blockAtoms(response: MiaResponse): Array<{ html: string; plainText: string }> {
  const atoms: Array<{ html: string; plainText: string }> = [];
  if (response.title) {
    const plainText = [response.title.emoji, response.title.text].filter(Boolean).join(" ");
    atoms.push({ html: headingHtml(response.title.emoji, response.title.text), plainText });
  }
  for (const block of response.blocks) {
    const lines: Array<{ html: string; plainText: string }> = [];
    if (block.heading) {
      lines.push({
        html: headingHtml(block.emoji, block.heading),
        plainText: [block.emoji, block.heading].filter(Boolean).join(" "),
      });
    }
    if (block.type === "table") {
      const header = block.columns.join(" | ");
      const separator = block.columns.map(() => "---").join(" | ");
      const rows = block.rows.map((row) => row.join(" | "));
      lines.push({
        html: `<pre>${escapeHtml([header, separator, ...rows].join("\n"))}</pre>`,
        plainText: [header, ...rows].join("\n"),
      });
    } else if (block.type === "paragraph" && block.text) {
      lines.push({ html: escapeHtml(block.text), plainText: block.text });
    } else if (block.type === "code" && block.text) {
      lines.push({ html: `<pre><code>${escapeHtml(block.text)}</code></pre>`, plainText: block.text });
    } else if (block.type === "quote" && block.text) {
      lines.push({ html: `<blockquote>${escapeHtml(block.text)}</blockquote>`, plainText: block.text });
    } else if (block.type === "details" && block.text) {
      lines.push({ html: escapeHtml(block.text), plainText: block.text });
    } else if (block.type === "list") {
      block.items.forEach((item, index) => {
        const marker = block.ordered ? `${index + 1}.` : "●";
        const plainText = `${marker} ${item.label ? `${item.label}：` : ""}${item.text}`;
        const html = `${marker} ${item.label ? `<b>${escapeHtml(item.label)}</b>：` : ""}${escapeHtml(item.text)}`;
        lines.push({ html, plainText });
      });
    } else if (block.type === "facts") {
      const factLines: Array<{ html: string; plainText: string }> = [];
      block.items.forEach((item) => {
        const label = item.label ?? "";
        factLines.push({
          html: label ? `<b>${escapeHtml(label)}：</b> ${escapeHtml(item.text)}` : escapeHtml(item.text),
          plainText: label ? `${label}：${item.text}` : item.text,
        });
      });
      lines.push({
        html: `<blockquote>${factLines.map((line) => line.html).join("\n")}</blockquote>`,
        plainText: factLines.map((line) => line.plainText).join("\n"),
      });
    }
    if (lines.length > 0) {
      atoms.push({ html: lines.map((line) => line.html).join("\n"), plainText: lines.map((line) => line.plainText).join("\n") });
    }
  }
  return atoms;
}

function splitAtom(atom: { html: string; plainText: string }): Array<{ html: string; plainText: string }> {
  if (atom.html.length <= TELEGRAM_MESSAGE_LIMIT) return [atom];
  const chunks: Array<{ html: string; plainText: string }> = [];
  let remaining = atom.plainText;
  while (remaining.length > 0) {
    let low = 1;
    let high = remaining.length;
    let end = 1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (escapeHtml(remaining.slice(0, middle)).length <= TELEGRAM_MESSAGE_LIMIT) {
        end = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    if (end < remaining.length) {
      const boundary = Math.max(remaining.lastIndexOf("\n", end), remaining.lastIndexOf(" ", end));
      if (boundary >= Math.floor(end / 2)) end = boundary;
    }
    const plainText = remaining.slice(0, end).trim();
    if (plainText) chunks.push({ html: escapeHtml(plainText), plainText });
    remaining = remaining.slice(end).trim();
  }
  return chunks;
}

export function renderTelegramHtml(value: MiaResponse): TelegramPresentationChunk[] {
  const response = normalizeMiaResponse(value);
  const atoms = blockAtoms(response).flatMap(splitAtom);
  const chunks: TelegramPresentationChunk[] = [];
  let current: TelegramPresentationChunk | null = null;
  for (const atom of atoms) {
    const next: TelegramPresentationChunk = current ? {
      html: `${current.html}\n\n${atom.html}`,
      plainText: `${current.plainText}\n\n${atom.plainText}`,
    } : atom;
    if (current && next.html.length > TELEGRAM_MESSAGE_LIMIT) {
      chunks.push(current);
      current = atom;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);
  return chunks.length > 0 ? chunks : [{ html: "...", plainText: miaResponsePlainText(response) || "..." }];
}
