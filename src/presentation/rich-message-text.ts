import type { RichBlock, RichText } from "grammy/types";

function richTextPlainText(value: RichText | undefined): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(richTextPlainText).join("");
  if ("text" in value) return richTextPlainText(value.text);
  if (value.type === "mathematical_expression") return value.expression;
  if (value.type === "button") return richTextPlainText(value.button.text);
  return "";
}

function captionText(block: RichBlock): string {
  if (!("caption" in block) || !block.caption) return "";
  const caption: unknown = block.caption;
  if (typeof caption === "object" && caption !== null && "text" in caption) {
    return richTextPlainText(caption.text as RichText);
  }
  return richTextPlainText(caption as RichText);
}

function blockPlainText(block: RichBlock): string {
  switch (block.type) {
    case "paragraph":
    case "heading":
    case "pre":
    case "footer":
    case "pullquote":
    case "expandable_blockquote":
    case "thinking":
      return richTextPlainText(block.text);
    case "mathematical_expression":
      return block.expression;
    case "divider":
      return "---";
    case "anchor":
      return "";
    case "list":
      return block.items.map((item) => {
        const body = item.blocks.map(blockPlainText).filter(Boolean).join("\n");
        return [item.label, body].filter(Boolean).join(" ");
      }).join("\n");
    case "blockquote":
      return block.blocks.map(blockPlainText).filter(Boolean).join("\n");
    case "table":
      return block.cells.map((row) => row.map((cell) => richTextPlainText(cell.text)).join(" | ")).join("\n");
    case "details": {
      const body = block.blocks.map(blockPlainText).filter(Boolean).join("\n");
      return [richTextPlainText(block.summary), body].filter(Boolean).join("\n");
    }
    case "collage":
    case "slideshow": {
      const body = block.blocks.map(blockPlainText).filter(Boolean).join("\n");
      return [body, captionText(block)].filter(Boolean).join("\n");
    }
    case "buttons":
      return block.buttons.map((button) => richTextPlainText(button.text)).filter(Boolean).join(" | ");
    case "map":
      return ["[map]", captionText(block)].filter(Boolean).join(" ");
    case "photo":
      return ["[photo]", captionText(block)].filter(Boolean).join(" ");
    case "video":
      return ["[video]", captionText(block)].filter(Boolean).join(" ");
    case "animation":
      return ["[animation]", captionText(block)].filter(Boolean).join(" ");
    case "audio":
      return ["[audio]", captionText(block)].filter(Boolean).join(" ");
    case "voice_note":
      return ["[voice]", captionText(block)].filter(Boolean).join(" ");
    case "document":
      return ["[document]", captionText(block)].filter(Boolean).join(" ");
  }
}

export function richMessagePlainText(blocks: readonly RichBlock[]): string {
  return blocks.map(blockPlainText).map((text) => text.trim()).filter(Boolean).join("\n\n");
}
