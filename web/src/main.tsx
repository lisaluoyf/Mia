import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { DebugApp } from "./DebugApp";
import { configureDocumentLocale, detectLocale, translator } from "./i18n";
import { applyTelegramTheme, initializeTelegram } from "./telegram";
import "./styles.css";

const isDebug = window.location.pathname.replace(/\/+$/, "") === "/mia/debug";
if (!isDebug) {
  initializeTelegram();
  applyTelegramTheme();
}
const locale = detectLocale();
configureDocumentLocale(locale);

createRoot(document.getElementById("root")!).render(
  <StrictMode>{isDebug ? <DebugApp /> : <App t={translator(locale)} />}</StrictMode>,
);
