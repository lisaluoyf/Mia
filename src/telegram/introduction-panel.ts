import { InlineKeyboard } from "grammy";

import type { BotLocale } from "./localization.js";

export type MiaIntroductionAction = "image" | "video" | "sticker";

interface IntroductionPanelCopy {
  image: string;
  video: string;
  sticker: string;
  settings: string;
  settingsPrompt: string;
  openSettings: string;
  prompts: Record<MiaIntroductionAction, { text: string; placeholder: string }>;
}

const ENGLISH: IntroductionPanelCopy = {
  image: "🖼 Generate image",
  video: "🎬 Generate video",
  sticker: "✨ Make sticker",
  settings: "⚙️ Model settings",
  settingsPrompt: "Open Mia settings to choose your chat, image, vision, and video models.",
  openSettings: "Open settings",
  prompts: {
    image: { text: "Reply with a description of the image you want to generate.", placeholder: "Describe your image" },
    video: { text: "Reply with a description of the video you want to generate.", placeholder: "Describe your video" },
    sticker: { text: "Reply with one image to turn it into a Telegram sticker.", placeholder: "Send one image" },
  },
};

const COPY: Partial<Record<BotLocale, IntroductionPanelCopy>> = {
  en: ENGLISH,
  "zh-CN": {
    image: "🖼 生成图片",
    video: "🎬 生成视频",
    sticker: "✨ 制作贴纸",
    settings: "⚙️ 模型设置",
    settingsPrompt: "打开 Mia 设置，选择聊天、图片、视觉和视频模型。",
    openSettings: "打开设置",
    prompts: {
      image: { text: "请回复这条消息，描述你想生成的图片。", placeholder: "描述你想生成的图片" },
      video: { text: "请回复这条消息，描述你想生成的视频。", placeholder: "描述你想生成的视频" },
      sticker: { text: "请回复这条消息并发送一张图片，我会把它做成 Telegram 贴纸。", placeholder: "发送一张图片" },
    },
  },
  "zh-TW": {
    image: "🖼 生成圖片",
    video: "🎬 生成影片",
    sticker: "✨ 製作貼圖",
    settings: "⚙️ 模型設定",
    settingsPrompt: "開啟 Mia 設定，選擇聊天、圖片、視覺和影片模型。",
    openSettings: "開啟設定",
    prompts: {
      image: { text: "請回覆這則訊息，描述你想生成的圖片。", placeholder: "描述你想生成的圖片" },
      video: { text: "請回覆這則訊息，描述你想生成的影片。", placeholder: "描述你想生成的影片" },
      sticker: { text: "請回覆這則訊息並傳送一張圖片，我會把它做成 Telegram 貼圖。", placeholder: "傳送一張圖片" },
    },
  },
};

function copyFor(locale: BotLocale): IntroductionPanelCopy {
  return COPY[locale] ?? ENGLISH;
}

function botDeepLink(username: string, payload: "sticker" | "settings"): string {
  const normalized = username.trim().replace(/^@/u, "");
  return `https://t.me/${encodeURIComponent(normalized)}?start=${payload}`;
}

export function miaIntroductionPanel(
  locale: BotLocale,
  username: string,
  options: { privateChat: boolean; miniAppUrl: string },
): InlineKeyboard {
  const copy = copyFor(locale);
  const keyboard = new InlineKeyboard()
    .text(copy.image, "intro_action:image")
    .text(copy.video, "intro_action:video").row();
  if (options.privateChat) keyboard.text(copy.sticker, "intro_action:sticker");
  else keyboard.url(copy.sticker, botDeepLink(username, "sticker"));
  if (options.privateChat) keyboard.webApp(copy.settings, options.miniAppUrl);
  else keyboard.url(copy.settings, botDeepLink(username, "settings"));
  return keyboard;
}

export function miaIntroductionActionPrompt(
  locale: BotLocale,
  action: MiaIntroductionAction,
): { text: string; placeholder: string } {
  return copyFor(locale).prompts[action];
}

export function miaSettingsLaunch(locale: BotLocale, miniAppUrl: string): {
  text: string;
  keyboard: InlineKeyboard;
} {
  const copy = copyFor(locale);
  return {
    text: copy.settingsPrompt,
    keyboard: new InlineKeyboard().webApp(copy.openSettings, miniAppUrl),
  };
}
