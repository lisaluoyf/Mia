interface TelegramThemeParams {
  bg_color?: string;
  text_color?: string;
  hint_color?: string;
  link_color?: string;
  button_color?: string;
  button_text_color?: string;
  secondary_bg_color?: string;
  section_bg_color?: string;
  section_separator_color?: string;
}

interface TelegramWebApp {
  initData: string;
  initDataUnsafe?: { user?: { id?: number; language_code?: string } };
  colorScheme?: "light" | "dark";
  themeParams?: TelegramThemeParams;
  viewportHeight?: number;
  viewportStableHeight?: number;
  ready(): void;
  expand(): void;
  onEvent?(eventType: "viewportChanged", eventHandler: (isStateStable: boolean) => void): void;
  enableClosingConfirmation(): void;
  isVersionAtLeast?(version: string): boolean;
  HapticFeedback?: { notificationOccurred(type: "error" | "success" | "warning"): void };
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

export function telegramApp(): TelegramWebApp | undefined {
  return window.Telegram?.WebApp;
}

export function initializeTelegram(): void {
  const app = telegramApp();
  app?.ready();
  app?.expand();
  syncTelegramViewport();
  app?.onEvent?.("viewportChanged", syncTelegramViewport);
}

function syncTelegramViewport(isStateStable = true): void {
  const app = telegramApp();
  if (!app) return;

  const root = document.documentElement;
  // Telegram updates viewportHeight while its sheet is moving. Keep dialog geometry
  // anchored to the stable value until that movement has finished.
  if (isStateStable && app.viewportStableHeight && Number.isFinite(app.viewportStableHeight)) {
    root.style.setProperty("--mia-sheet-height", `${Math.floor(app.viewportStableHeight * 0.84)}px`);
  }
}

export function enableClosingConfirmation(): void {
  const app = telegramApp();
  if (app?.isVersionAtLeast?.("6.2")) {
    app.enableClosingConfirmation();
  }
}

export function notifyHaptic(type: "error" | "success" | "warning"): void {
  const app = telegramApp();
  if (app?.isVersionAtLeast?.("6.1")) {
    app.HapticFeedback?.notificationOccurred(type);
  }
}

export function telegramLanguage(): string | undefined {
  return telegramApp()?.initDataUnsafe?.user?.language_code;
}

export function applyTelegramTheme(): void {
  const app = telegramApp();
  const root = document.documentElement;
  const previewTheme = import.meta.env.DEV ? new URLSearchParams(window.location.search).get("theme") : null;
  if (previewTheme === "dark" || previewTheme === "light") {
    root.dataset.theme = previewTheme;
  } else if (app?.colorScheme) {
    root.dataset.theme = app.colorScheme;
  }
  const theme = app?.themeParams;
  if (!theme) return;
  const values: Record<string, string | undefined> = {
    "--tg-bg": theme.bg_color,
    "--tg-text": theme.text_color,
    "--tg-hint": theme.hint_color,
    "--tg-link": theme.link_color,
    "--tg-button": theme.button_color,
    "--tg-button-text": theme.button_text_color,
    "--tg-secondary-bg": theme.secondary_bg_color,
    "--tg-section-bg": theme.section_bg_color,
    "--tg-separator": theme.section_separator_color,
  };
  for (const [property, value] of Object.entries(values)) {
    if (value) root.style.setProperty(property, value);
  }
}
