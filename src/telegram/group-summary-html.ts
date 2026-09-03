import type { GroupSummaryContent } from "../context/group-summary.js";
import type { MiaResponse, MiaResponseBlock } from "../presentation/schema.js";
import { renderTelegramHtml } from "../presentation/telegram-html.js";

function isChinese(locale: string): boolean {
  return locale.toLowerCase().startsWith("zh");
}

export function groupSummaryPresentation(content: GroupSummaryContent, locale: string): MiaResponse {
  const chinese = isChinese(locale);
  const blocks: MiaResponseBlock[] = [];
  if (content.topics.length > 0) {
    blocks.push({
      type: "list",
      heading: null,
      emoji: null,
      text: null,
      items: content.topics.map((topic) => ({ label: topic.title, text: topic.detail })),
      ordered: false,
      language: null,
    });
  }
  const addSection = (heading: string, emoji: string, entries: readonly { text: string }[]) => {
    if (entries.length === 0) return;
    blocks.push({
      type: "list", heading, emoji, text: null,
      items: entries.map((entry) => ({ label: null, text: entry.text })), ordered: false, language: null,
    });
  };
  addSection(chinese ? "定下来的" : "Decided", "✅", content.decisions);
  addSection(chinese ? "接下来" : "Next", "📌", content.todos);
  addSection(chinese ? "还没定" : "Still open", "💭", content.openQuestions);
  if (content.participants.length > 1) {
    blocks.push({
      type: "list", heading: chinese ? "谁做了什么" : "Who contributed", emoji: null, text: null,
      items: content.participants.map((item) => ({ label: item.name, text: item.contribution })),
      ordered: false, language: null,
    });
  }
  addSection(chinese ? "之前还提到" : "Earlier context", "↩️", content.historicalContext);
  if (content.overview) {
    blocks.push({
      type: "paragraph", heading: null, emoji: null, text: content.overview.text,
      items: [],
      ordered: false, language: null,
    });
  }
  if (blocks.length === 0) {
    blocks.push({
      type: "paragraph", heading: null, emoji: null,
      text: chinese ? "这段对话里暂时没有足够的信息可以总结。" : "There is not enough context to summarize yet.",
      items: [], ordered: false, language: null,
    });
  }
  return {
    version: 1,
    title: { text: content.title?.text ?? (chinese ? "群聊总结" : "Chat summary"), emoji: "📝" },
    blocks,
    actions: [],
  };
}

export function renderGroupSummaryHtml(content: GroupSummaryContent, _messageCount: number, locale: string): string[] {
  return renderTelegramHtml(groupSummaryPresentation(content, locale)).map((chunk) => chunk.html);
}
