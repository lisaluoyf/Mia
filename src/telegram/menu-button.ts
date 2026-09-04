import { botText } from "./localization.js";

export function settingsMenuButton(language: string | null | undefined, url: string) {
  return {
    type: "web_app" as const,
    text: botText(language, "settings"),
    web_app: { url },
  };
}
