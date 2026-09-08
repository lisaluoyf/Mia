import { InlineKeyboard } from "grammy";

import { miaIntroduction } from "../identity.js";
import { miaResponsePlainText } from "../presentation/schema.js";
import { miaIntroductionPanel } from "../telegram/introduction-panel.js";
import { resolveBotLocale, type BotLocale } from "../telegram/localization.js";
import type { ActivationTemplateId } from "./types.js";

interface TemplateCopy { text: string; keyboard: InlineKeyboard; }
interface ActivationTemplateOptions { botUsername: string; miniAppUrl: string; }

function localized(locale: BotLocale, chinese: string, english: string): string {
  return locale === "zh-CN" || locale === "zh-TW" ? chinese : english;
}

export function activationTemplate(
  id: ActivationTemplateId,
  language?: string | null,
  options: ActivationTemplateOptions = { botUsername: "apimasterai_bot", miniAppUrl: "https://apimaster.ai/mia/" },
): TemplateCopy {
  const locale = resolveBotLocale(language);
  switch (id) {
    case "introduction_v1":
      return {
        text: miaResponsePlainText(miaIntroduction(locale)),
        keyboard: miaIntroductionPanel(locale, options.botUsername, {
          privateChat: true,
          miniAppUrl: options.miniAppUrl,
        }),
      };
    case "weather_invite_v1":
      return {
        text: localized(locale,
          "想看看天气吗？发一个城市名给我，我查今天和明天的天气。",
          "Want to check the weather? Send me a city name and I'll look up today and tomorrow."),
        keyboard: new InlineKeyboard().text(localized(locale, "查天气", "Check weather"), "activation:weather"),
      };
    case "companion_v1":
      return {
        text: localized(locale,
          "想找人聊聊天、吐槽一下，或者只是随便说几句吗？我在。",
          "Want to chat, vent, or just say a few things? I'm here."),
        keyboard: new InlineKeyboard().text(localized(locale, "和 Mia 聊聊", "Chat with Mia"), "activation:companion").row()
          .text(localized(locale, "暂时不用", "Not now"), "activation:dismiss"),
      };
  }
}

export function weatherSubscriptionKeyboard(language?: string | null): InlineKeyboard {
  const locale = resolveBotLocale(language);
  return new InlineKeyboard()
    .text(localized(locale, "每天早上 8:00", "Every day at 8:00"), "activation:weather:subscribe:8")
    .text(localized(locale, "每天早上 9:00", "Every day at 9:00"), "activation:weather:subscribe:9").row()
    .text(localized(locale, "暂不订阅", "Not now"), "activation:dismiss");
}

export function dailyWeatherKeyboard(language?: string | null): InlineKeyboard {
  const locale = resolveBotLocale(language);
  return new InlineKeyboard()
    .text(localized(locale, "明天怎么样", "How about tomorrow?"), "activation:weather:tomorrow").row()
    .text(localized(locale, "暂停天气", "Pause weather"), "activation:weather:pause")
    .text(localized(locale, "取消订阅", "Cancel subscription"), "activation:weather:cancel");
}
