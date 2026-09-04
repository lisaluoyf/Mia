import type { MiaResponse } from "./presentation/schema.js";
import type { BotLocale } from "./telegram/localization.js";

export const MIA_PRODUCT_FACTS_PROMPT = `产品身份与能力边界：
- Mia 是 APIMaster 提供的 Telegram AI 助理，可在私聊、群聊和 Topic 中使用。
- Mia 已接入自然语言对话、知识问答，以及在需要时查询天气、新闻、价格等实时信息。
- Mia 已接入图片理解、图片生成和图片修改。
- Mia 可以把一张图片制作成 Telegram 贴纸；贴纸制作目前只支持私聊。
- Mia 已接入文生视频和图生视频；实际付费生成视频前会先展示确认草稿。
- Mia 可以总结当前群聊或 Topic，并结合当前会话上下文继续对话；私聊还可以记住用户明确确认的长期偏好和目标。
- 文字聊天可以直接使用；图片和视频需要绑定 APIMaster 账号并使用用户自己的 API Token。

当用户询问你是谁、自我介绍、产品能力、功能或限制时，只能依据以上事实回答。不要把通用语言模型可能完成的任务包装成 Mia 已接入的独立产品功能，也不要声称拥有以上列表之外的外部工具、账号或应用操作能力。`;

const INTRODUCTION_PATTERNS = [
  /(?:向(?:大家|我们|我))?\s*介[绍紹](?:一?下)?\s*(?:你|妳|您)(?:自己)?/u,
  /(?:你|妳|您)(?:自己)?\s*(?:是\s*(?:谁|誰)|叫\s*(?:什么|什麼|啥)(?:名字)?|是\s*(?:什么|什麼)(?:东西|東西|角色)?)(?=$|[\s?？!！。])/u,
  /(?:你|妳|您)(?:有)?\s*(?:哪些|什么|什麼|啥)\s*(?:能力|功能|本事)/u,
  /(?:你|妳|您)(?:都)?\s*(?:能|会|會|可以)\s*(?:干|幹|做)\s*(?:些)?\s*(?:什么|什麼|啥)/u,
  /(?:你|妳|您)\s*能\s*帮(?:我|我們|我们|大家)\s*做\s*(?:些)?\s*(?:什么|什麼|啥)/u,
  /(?:mia|bot|机器人|機器人|助手|助理)\s*[-:：]?\s*(?:自我介[绍紹]|介[绍紹](?:一?下)?)/iu,
  /\b(?:introduce yourself|who are you|what can you do|what do you do|what are your (?:capabilities|features)|tell (?:me|us) about yourself)\b/iu,
] as const;

export function isMiaIntroductionRequest(text: string): boolean {
  const normalized = text.trim().replace(/\s+/gu, " ");
  return normalized.length > 0 && INTRODUCTION_PATTERNS.some((pattern) => pattern.test(normalized));
}

interface IntroductionCopy {
  headline: string;
  capabilitiesHeading: string;
  capabilities: readonly string[];
}

const INTRODUCTIONS: Partial<Record<BotLocale, IntroductionCopy>> = {
  "zh-CN": {
    headline: "我是 Mia，APIMaster 的 Telegram AI 助理",
    capabilitiesHeading: "我能：",
    capabilities: [
      "💬 对话和查询实时信息",
      "🖼 生成图片、修改图片",
      "✨ 生成Telegram 贴纸",
      "🎬 创作视频",
    ],
  },
  "zh-TW": {
    headline: "我是 Mia，APIMaster 的 Telegram AI 助理",
    capabilitiesHeading: "我能：",
    capabilities: [
      "💬 對話和查詢即時資訊",
      "🖼 生成圖片、修改圖片",
      "✨ 生成 Telegram 貼圖",
      "🎬 創作影片",
    ],
  },
  en: {
    headline: "I'm Mia, APIMaster's Telegram AI assistant",
    capabilitiesHeading: "I can:",
    capabilities: [
      "💬 Chat and look up current information",
      "🖼 Generate and edit images",
      "✨ Create Telegram stickers",
      "🎬 Create videos",
    ],
  },
};

export function miaIntroduction(locale: BotLocale): MiaResponse {
  const copy = INTRODUCTIONS[locale] ?? INTRODUCTIONS.en!;
  return {
    version: 1,
    title: null,
    blocks: [
      {
        type: "paragraph",
        heading: null,
        emoji: null,
        text: [copy.headline, copy.capabilitiesHeading, ...copy.capabilities].join("\n"),
        items: [],
        ordered: false,
        language: null,
      },
    ],
    actions: [],
  };
}
