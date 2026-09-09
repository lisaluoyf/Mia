import { InlineKeyboard } from "grammy";
import type { MediaJob } from "../media/types.js";
import { botText, mediaJobLocale } from "./localization.js";

export function videoDraftText(job: MediaJob): string {
  const locale = mediaJobLocale(job.options);
  const mode = String(job.options.mode) === "image_to_video"
    ? botText(locale, "modeImageToVideo")
    : botText(locale, "modeTextToVideo");
  return [
    botText(locale, "videoDraftTitle"),
    botText(locale, "modelLabel", { value: job.model }),
    botText(locale, "modeLabel", { value: mode }),
    botText(locale, "promptLabel", { value: job.instruction }),
    botText(locale, "durationLabel", { value: String(job.options.durationSeconds) }),
    botText(locale, "aspectRatioLabel", { value: String(job.options.aspectRatio) }),
    botText(locale, "resolutionLabel", {
      value: job.options.resolutionSource === "channel_default"
        ? botText(locale, "channelDefaultResolution")
        : String(job.options.resolution),
    }),
    botText(locale, "draftExpires"),
  ].join("\n");
}

export function draftKeyboard(job: MediaJob): InlineKeyboard {
  const locale = mediaJobLocale(job.options);
  return new InlineKeyboard()
    .text("-1s", `media:${job.id}:dur_down`).text("+1s", `media:${job.id}:dur_up`)
    .text(botText(locale, "ratioButton"), `media:${job.id}:ratio`).row()
    .text(botText(locale, "generateVideoButton"), `media:${job.id}:generate`)
    .text(botText(locale, "cancelButton"), `media:${job.id}:cancel`);
}
