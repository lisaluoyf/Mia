import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { configureDocumentLocale, detectLocale, translator } from "./i18n";
import { applyTelegramTheme, initializeTelegram } from "./telegram";
import "./styles.css";

initializeTelegram();
applyTelegramTheme();
const locale = detectLocale();
configureDocumentLocale(locale);

createRoot(document.getElementById("root")!).render(
  <StrictMode><App t={translator(locale)} /></StrictMode>,
);
