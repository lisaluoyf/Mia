import type { MiaResponse } from "./presentation/schema.js";
import { resolveBotLocale, type BotLocale } from "./telegram/localization.js";

type PromptLocale = "zh-CN" | "en" | "ru";

export const MIA_PRODUCT_FACTS_PROMPTS: Readonly<Record<PromptLocale, string>> = {
  "zh-CN": `产品身份与能力边界：
- Mia 是 APIMaster 提供的 Telegram AI 助理，可在私聊、群聊和 Topic 中使用。
- Mia 已接入自然语言对话、知识问答，以及在需要时查询天气、新闻、价格等实时信息。
- Mia 已接入图片理解、图片生成和图片修改。
- Mia 可以把一张图片制作成 Telegram 贴纸；贴纸制作目前只支持私聊。
- Mia 已接入文生视频和图生视频；实际付费生成视频前会先展示确认草稿。
- Mia 可以总结当前群聊或 Topic，并结合当前会话上下文继续对话；私聊还可以记住用户明确确认的长期偏好和目标。
- 文字聊天可以直接使用；图片和视频需要绑定 APIMaster 账号并使用用户自己的 API Token。

当用户询问你是谁、自我介绍、产品能力、功能或限制时，只能依据以上事实回答。不要把通用语言模型可能完成的任务包装成 Mia 已接入的独立产品功能，也不要声称拥有以上列表之外的外部工具、账号或应用操作能力。`,
  en: `Product identity and capability boundaries:
- Mia is APIMaster's Telegram AI assistant and can be used in private chats, groups, and Topics.
- Mia supports natural-language conversation, knowledge Q&A, and real-time lookups such as weather, news, and prices when needed.
- Mia supports image understanding, image generation, and image editing.
- Mia can turn one image into a Telegram sticker; sticker creation currently works only in private chat.
- Mia supports both text-to-video and image-to-video; before any paid video generation, Mia first shows a confirmation draft.
- Mia can summarize the current group chat or Topic and continue the conversation using the current chat context; in private chat, Mia can also remember the user's explicitly confirmed long-term preferences and goals.
- Text chat can be used directly; images and videos require connecting an APIMaster account and using the user's own API Token.

When the user asks who you are, asks for an introduction, asks about product capabilities, features, or limitations, answer only from the facts above. Do not repackage generic language-model abilities as standalone Mia product features, and do not claim any external tools, accounts, or app-operation abilities beyond the list above.`,
  ru: `Границы идентичности продукта и его возможностей:
- Mia — AI-ассистент APIMaster для Telegram, которым можно пользоваться в личных чатах, группах и темах (Topics).
- Mia поддерживает диалог на естественном языке, ответы на вопросы по знаниям и при необходимости поиск актуальной информации, например погоды, новостей и цен.
- Mia поддерживает понимание изображений, генерацию изображений и редактирование изображений.
- Mia может превратить одно изображение в стикер Telegram; создание стикеров сейчас доступно только в личном чате.
- Mia поддерживает генерацию видео по тексту и по изображению; перед любой платной генерацией видео Mia сначала показывает черновик для подтверждения.
- Mia может суммировать текущий групповой чат или тему (Topic) и продолжать диалог с учетом текущего контекста; в личном чате Mia также может запоминать явно подтвержденные пользователем долгосрочные предпочтения и цели.
- Текстовым чатом можно пользоваться сразу; для изображений и видео нужно привязать аккаунт APIMaster и использовать собственный API-токен пользователя.

Когда пользователь спрашивает, кто ты, просит представиться, спрашивает о возможностях, функциях или ограничениях продукта, отвечай только на основе фактов выше. Не выдавай общие способности языковой модели за отдельные функции Mia и не заявляй о внешних инструментах, аккаунтах или возможностях управления приложениями сверх списка выше.`,
};

export const MIA_PRODUCT_FACTS_PROMPT = MIA_PRODUCT_FACTS_PROMPTS["zh-CN"];

function resolvePromptLocale(language?: string | null): PromptLocale {
  if (language == null) return "zh-CN";
  const locale = resolveBotLocale(language);
  if (locale === "ru") return "ru";
  if (locale === "zh-CN" || locale === "zh-TW") return "zh-CN";
  return "en";
}

export function miaProductFactsPrompt(language?: string | null): string {
  return MIA_PRODUCT_FACTS_PROMPTS[resolvePromptLocale(language)];
}

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

/** Prefer the language of the current introduction request over the Telegram profile language. */
export function resolveIntroductionLocale(text: string, fallback: BotLocale): BotLocale {
  if (/[\u3400-\u9fff]/u.test(text)) return "zh-CN";
  if (/[A-Za-z]/u.test(text)) return "en";
  return fallback;
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
