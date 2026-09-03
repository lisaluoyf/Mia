import { TELEGRAM_MESSAGE_LIMIT } from "../constants.js";
import type { GroupSummaryContent } from "../context/group-summary.js";

function escapeHtml(value: string): string {
  return value.replaceAll("**", "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function splitEscapedText(value: string, maxLength: number): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const character of value.replaceAll("**", "")) {
    const escaped = escapeHtml(character);
    if (current && current.length + escaped.length > maxLength) {
      chunks.push(current);
      current = escaped;
    } else {
      current += escaped;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function itemAtoms(text: string): string[] {
  return splitEscapedText(text, TELEGRAM_MESSAGE_LIMIT - 4).map((part) => `• ${part}`);
}

function sectionAtoms(label: string, entries: readonly string[]): string[] {
  if (entries.length === 0) return [];
  const heading = `<b>${escapeHtml(label)}</b>`;
  const items = entries.flatMap(itemAtoms);
  return [heading, ...items];
}

function pack(atoms: readonly string[]): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const atom of atoms) {
    const candidate = current ? `${current}\n\n${atom}` : atom;
    if (current && candidate.length > TELEGRAM_MESSAGE_LIMIT) {
      chunks.push(current);
      current = atom;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export function renderGroupSummaryHtml(content: GroupSummaryContent, messageCount: number, locale: string): string[] {
  const chinese = locale.toLowerCase().startsWith("zh");
  const labels = chinese ? {
    fallbackTitle: "群聊总结",
    overview: "概览",
    topics: "主要话题",
    decisions: "已确认结论",
    todos: "待办",
    openQuestions: "未决问题",
    participants: "参与者",
    historicalContext: "历史关联",
    coverage: "覆盖说明",
    coverageText: `基于 Mia 实际收到的 ${messageCount} 条消息整理。`,
  } : {
    fallbackTitle: "Chat summary",
    overview: "Overview",
    topics: "Main topics",
    decisions: "Confirmed decisions",
    todos: "To-dos",
    openQuestions: "Open questions",
    participants: "Participants",
    historicalContext: "Historical context",
    coverage: "Coverage",
    coverageText: `Based on ${messageCount} messages actually received by Mia.`,
  };
  const title = content.title?.text ?? labels.fallbackTitle;
  const atoms = [
    `<b>${escapeHtml(title)}</b>`,
    ...sectionAtoms(labels.overview, content.overview ? [content.overview.text] : []),
    ...sectionAtoms(labels.topics, content.topics.map((topic) => `${topic.title}：${topic.detail}`)),
    ...sectionAtoms(labels.decisions, content.decisions.map((item) => item.text)),
    ...sectionAtoms(labels.todos, content.todos.map((item) => item.text)),
    ...sectionAtoms(labels.openQuestions, content.openQuestions.map((item) => item.text)),
    ...sectionAtoms(labels.participants, content.participants.map((item) => `${item.name}：${item.contribution}`)),
    ...sectionAtoms(labels.historicalContext, content.historicalContext.map((item) => item.text)),
    ...sectionAtoms(labels.coverage, [labels.coverageText]),
  ];
  return pack(atoms);
}
