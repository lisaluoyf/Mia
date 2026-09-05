import { BOT_LOCALES, type BotLocale } from "./localization.js";

// Keep the picker optimized for the languages Mia users are most likely to need,
// rather than inheriting the alphabetical locale registry order.
export const TRANSLATION_PICKER_LANGUAGES = [
  "zh-CN", "en", "ru", "es", "pt-BR", "ja", "ko", "fr",
  "de", "ar", "hi", "it", "tr", "id", "vi", "th",
  "pl", "uk", "fa", "nl", "pt", "ms", "zh-TW", "cs", "uz",
] as const satisfies readonly BotLocale[];
export type TranslationLanguage = typeof TRANSLATION_PICKER_LANGUAGES[number];

const languageSet = new Set<string>(TRANSLATION_PICKER_LANGUAGES);
const aliases = new Map<string, TranslationLanguage>();

function normalized(value: string): string {
  return value.normalize("NFKC").replaceAll("_", "-").replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

function registerAlias(value: string | undefined, language: TranslationLanguage): void {
  if (value?.trim()) aliases.set(normalized(value), language);
}

function languageVariant(language: TranslationLanguage): string {
  if (language === "zh-CN") return "zh-Hans";
  if (language === "zh-TW") return "zh-Hant";
  return language;
}

function languageBase(language: TranslationLanguage): string {
  return new Intl.Locale(language).language;
}

for (const language of TRANSLATION_PICKER_LANGUAGES) {
  registerAlias(language, language);
  registerAlias(languageVariant(language), language);
  for (const locale of BOT_LOCALES) {
    const displayNames = new Intl.DisplayNames([locale], { type: "language" });
    registerAlias(displayNames.of(language), language);
    registerAlias(displayNames.of(languageVariant(language)), language);
  }
}

for (const [legacy, language] of Object.entries({
  "simplified chinese": "zh-CN",
  "traditional chinese": "zh-TW",
  "chinese": "zh-CN",
  "chinese (china)": "zh-CN",
  "chinese (taiwan)": "zh-TW",
  "portuguese (brazil)": "pt-BR",
} as const)) {
  registerAlias(legacy, language);
}

function fromLocaleTag(value: string): TranslationLanguage | null {
  try {
    const locale = new Intl.Locale(value);
    const canonical = locale.toString();
    const normalizedCode = normalized(canonical);
    if (normalizedCode.includes("hant") || /^zh-(tw|hk|mo)(-|$)/.test(normalizedCode)) return "zh-TW";
    if (normalizedCode.startsWith("zh")) return "zh-CN";
    if (normalizedCode === "pt-br" || normalizedCode.startsWith("pt-br-")) return "pt-BR";
    const base = locale.language;
    return languageSet.has(base) ? base as TranslationLanguage : null;
  } catch {
    return null;
  }
}

export function canonicalTranslationLanguage(value: string | null | undefined): TranslationLanguage | null {
  if (!value?.trim()) return null;
  return fromLocaleTag(value) ?? aliases.get(normalized(value)) ?? null;
}

export function defaultTranslationLanguage(languageCode?: string | null): TranslationLanguage {
  return canonicalTranslationLanguage(languageCode) ?? "en";
}

export function defaultTranslationPair(languageCode?: string | null): { leftLanguage: TranslationLanguage; rightLanguage: TranslationLanguage } {
  const leftLanguage = defaultTranslationLanguage(languageCode);
  return { leftLanguage, rightLanguage: leftLanguage === "en" ? "zh-CN" : "en" };
}

export function translationLanguageLabel(
  language: TranslationLanguage,
  locale: BotLocale,
  options: { picker?: boolean } = {},
): string {
  const displayNames = new Intl.DisplayNames([locale], { type: "language" });
  const code = options.picker ? languageVariant(language) : languageBase(language);
  return displayNames.of(code) ?? language;
}
