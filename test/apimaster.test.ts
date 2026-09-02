import { describe, expect, it, vi } from "vitest";

import { APIMasterClient } from "../src/clients/apimaster.js";
import { DEFAULT_MODELS, SYSTEM_PROMPT } from "../src/constants.js";

function createClient(fetcher: typeof fetch): APIMasterClient {
  return new APIMasterClient({
    baseUrl: "https://apimaster.example",
    internalBaseUrl: "http://127.0.0.1:3000",
    serviceKey: "internal-secret-value",
    timeoutMs: 5000,
    fetcher,
  });
}

describe("APIMaster client", () => {
  it("resolves the bound user's API key using grok-4.5", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        success: true,
        data: { user_id: 7, token_id: 9, api_key: "user-api-key" },
      }),
    );
    const client = createClient(fetcher);

    await expect(client.resolveAPIKey(123456, DEFAULT_MODELS.chat)).resolves.toBe("user-api-key");
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe("http://127.0.0.1:3000/api/user/internal/telegram-api-key");
    const requestBody: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    expect(requestBody).toEqual({
      telegram_user_id: "123456",
      model: DEFAULT_MODELS.chat,
    });
  });

  it("sends chat completions with the user's selected model", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ choices: [{ message: { content: "你好" } }] }),
    );
    const client = createClient(fetcher);

    await expect(client.chat("user-api-key", "gpt-5.5", "hello")).resolves.toBe("你好");
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe("https://apimaster.example/v1/chat/completions");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer user-api-key");
    const requestBody: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    expect(requestBody).toEqual({
      model: "gpt-5.5",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: "hello" },
      ],
      stream: false,
    });
  });

  it("loads the user's model catalog without exposing a key", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      success: true,
      data: {
        user_id: 7,
        models: [{
          id: "minimax-h3",
          display_name: "MiniMax H3",
          vendor: "MiniMax",
          capability: "video",
          recommended: true,
          supported_endpoint_types: ["openai-video"],
        }],
      },
    }));
    const client = createClient(fetcher);

    await expect(client.listModels(123456)).resolves.toEqual({
      apimasterUserId: 7,
      models: [{
        id: "minimax-h3",
        displayName: "MiniMax H3",
        vendor: "MiniMax",
        capability: "video",
        recommended: true,
      }],
    });
    expect(JSON.stringify(fetcher.mock.calls)).not.toContain("user-api-key");
  });
});
