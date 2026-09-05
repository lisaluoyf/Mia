import ar from "./ar.json";
import cs from "./cs.json";
import de from "./de.json";
import en from "./en.json";
import es from "./es.json";
import fa from "./fa.json";
import fr from "./fr.json";
import hi from "./hi.json";
import id from "./id.json";
import it from "./it.json";
import ja from "./ja.json";
import ko from "./ko.json";
import ms from "./ms.json";
import nl from "./nl.json";
import pl from "./pl.json";
import pt from "./pt.json";
import ptBR from "./pt-BR.json";
import ru from "./ru.json";
import th from "./th.json";
import tr from "./tr.json";
import uk from "./uk.json";
import uz from "./uz.json";
import vi from "./vi.json";
import zhCN from "./zh-CN.json";
import zhTW from "./zh-TW.json";

import { telegramLanguage } from "../telegram";

const messages = {
  ar, cs, de, en, es, fa, fr, hi, id, it, ja, ko, ms, nl, pl, pt,
  "pt-BR": ptBR, ru, th, tr, uk, uz, vi, "zh-CN": zhCN, "zh-TW": zhTW,
} as const;

export type Locale = keyof typeof messages;
export type TranslationKey = keyof typeof en;

const rtlLocales = new Set<Locale>(["ar", "fa"]);

export function resolveLocale(language?: string): Locale {
  const normalized = language?.replace("_", "-").toLowerCase() ?? "";
  if (normalized.includes("hant") || /^zh-(tw|hk|mo)(-|$)/.test(normalized)) return "zh-TW";
  if (normalized.startsWith("zh")) return "zh-CN";
  if (normalized === "pt-br") return "pt-BR";
  const base = normalized.split("-")[0] as Locale | undefined;
  return base && base in messages ? base : "en";
}

export function detectLocale(): Locale {
  const previewLocale = import.meta.env.DEV ? new URLSearchParams(window.location.search).get("lang") ?? undefined : undefined;
  const candidates = [previewLocale, telegramLanguage(), ...navigator.languages, navigator.language];
  for (const candidate of candidates) {
    const locale = resolveLocale(candidate);
    if (locale !== "en" || candidate?.toLowerCase().startsWith("en")) return locale;
  }
  return "en";
}

export function configureDocumentLocale(locale: Locale): void {
  document.documentElement.lang = locale;
  document.documentElement.dir = rtlLocales.has(locale) ? "rtl" : "ltr";
}

export function translator(locale: Locale) {
  return (key: TranslationKey): string =>
    (messages[locale] as Partial<Record<TranslationKey, string>>)[key] ?? en[key];
}
