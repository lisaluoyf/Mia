import type { BootstrapData, Preferences } from "./types";
import { telegramApp } from "./telegram";

class ApiError extends Error {
  constructor(public readonly code: string, public readonly status: number) {
    super(code);
    this.name = "ApiError";
  }
}

const previewData: BootstrapData = {
  user: { id: 1, firstName: "Lisa", lastName: null, username: "lisa", languageCode: "en", photoUrl: null },
  apimasterUserId: 1,
  models: [
    { id: "grok-4.5", displayName: "Grok 4.5", vendor: "xAI", capability: "chat", recommended: true },
    { id: "gpt-5.5", displayName: "GPT-5.5", vendor: "OpenAI", capability: "chat", recommended: false },
    { id: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6", vendor: "Anthropic", capability: "chat", recommended: false },
    { id: "gpt-image-2", displayName: "GPT Image 2", vendor: "OpenAI", capability: "image", recommended: true },
    { id: "gemini-3.1-flash-image", displayName: "Gemini 3.1 Flash Image", vendor: "Google", capability: "image", recommended: false },
    { id: "minimax-h3", displayName: "MiniMax H3", vendor: "MiniMax", capability: "video", recommended: true },
    { id: "sora-2", displayName: "Sora 2", vendor: "OpenAI", capability: "video", recommended: false },
  ],
  settings: { chatModel: "grok-4.5", imageModel: "gpt-image-2", videoModel: "minimax-h3" },
  unavailable: [],
};

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const initData = telegramApp()?.initData ?? "";
  const preview = import.meta.env.DEV && new URLSearchParams(window.location.search).get("preview") === "1";
  if (import.meta.env.DEV && (!initData || preview)) {
    await new Promise((resolve) => window.setTimeout(resolve, 180));
    if (url.endsWith("/bootstrap")) return { success: true, data: previewData } as T;
    const parsed: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : previewData.settings;
    return { success: true, data: parsed } as T;
  }
  const response = await fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-telegram-init-data": initData,
      ...init?.headers,
    },
  });
  const payload = await response.json() as { success?: boolean; code?: string };
  if (!response.ok || payload.success === false) {
    throw new ApiError(payload.code ?? "service_unavailable", response.status);
  }
  return payload as T;
}

export async function loadBootstrap(): Promise<BootstrapData> {
  const response = await request<{ success: true; data: BootstrapData }>("/mia/api/bootstrap");
  return response.data;
}

export async function savePreferences(settings: Preferences): Promise<Preferences> {
  const response = await request<{ success: true; data: Preferences }>("/mia/api/settings", {
    method: "PUT",
    body: JSON.stringify(settings),
  });
  return response.data;
}

export { ApiError };
