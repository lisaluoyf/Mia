import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { APIMasterClient } from "../src/clients/apimaster.js";
import { DEFAULT_MODELS } from "../src/constants.js";
import { MIA_SYSTEM_PROMPT } from "../src/prompts.js";

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

  it("submits text images as JSON and reference images as multipart", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ data: [{ task_id: "img-1", status: "submitted" }] }))
      .mockResolvedValueOnce(Response.json({ data: [{ task_id: "img-2", status: "submitted" }] }));
    const client = createClient(fetcher);
    await client.submitImage("key", "gpt-image-2", "sunset", "16:9");
    await client.submitImage("key", "gpt-image-2", "brighter", "1:1", [{
      bytes: new Uint8Array([0xff, 0xd8, 0xff]), mimeType: "image/jpeg", filename: "a.jpg",
    }]);
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://apimaster.example/v1/images/generations/async");
    const imageBody = fetcher.mock.calls[0]?.[1]?.body;
    expect(typeof imageBody === "string" ? JSON.parse(imageBody) as unknown : null).toMatchObject({ n: 1, resolution: "1K", size: "16:9" });
    const form = fetcher.mock.calls[1]?.[1]?.body;
    expect(form).toBeInstanceOf(FormData);
    expect((form as FormData).getAll("images")).toHaveLength(1);
  });

  it("submits video parameters and ordered image roles through /v1/videos", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id: "video-1", status: "queued" }));
    const client = createClient(fetcher);
    await client.submitVideo("key", {
      model: "minimax-h3", prompt: "move", durationSeconds: 4, aspectRatio: "9:16", resolution: "768P",
      images: [
        { dataUrl: "data:image/png;base64,AA==", role: "first_frame" },
        { dataUrl: "data:image/png;base64,AQ==", role: "last_frame" },
      ],
    });
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://apimaster.example/v1/videos");
    const rawBody = fetcher.mock.calls[0]?.[1]?.body;
    const body = z.object({
      metadata: z.object({
        duration: z.number(), resolution: z.string(), ratio: z.string(),
        content: z.array(z.object({ role: z.string().optional() }).passthrough()),
      }).passthrough(),
    }).parse(typeof rawBody === "string" ? JSON.parse(rawBody) as unknown : null);
    expect(body.metadata).toMatchObject({ duration: 4, resolution: "768P", ratio: "9:16" });
    expect(body.metadata.content.map((item) => item.role).filter(Boolean)).toEqual(["first_frame", "last_frame"]);
  });

  it("never forwards a user's key to an external media result URL", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), {
      headers: { "content-type": "image/png" },
    }));
    const client = createClient(fetcher);
    await client.getContent("user-secret", "https://cdn.example/result.png", 100);
    const headers = new Headers(fetcher.mock.calls[0]?.[1]?.headers);
    expect(headers.has("authorization")).toBe(false);
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
        { role: "system", content: MIA_SYSTEM_PROMPT },
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
          supports_vision: false,
          vision_recommended: false,
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
        supportsVision: false,
        visionRecommended: false,
        videoCapabilities: undefined,
      }],
    });
    expect(JSON.stringify(fetcher.mock.calls)).not.toContain("user-api-key");
  });
});
