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

  it("submits text images asynchronously and reference images through synchronous edits", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ data: [{ task_id: "img-1", status: "submitted" }] }))
      .mockResolvedValueOnce(Response.json({ data: [{ b64_json: "aW1hZ2U=" }] }))
      .mockResolvedValueOnce(Response.json({ data: [{ url: "https://cdn.example/edited.png" }] }));
    const client = createClient(fetcher);
    await expect(client.submitImage("key", "gpt-image-2", "sunset", "16:9")).resolves.toEqual({
      kind: "task",
      taskId: "img-1",
    });
    await expect(client.submitImage("key", "gpt-image-2", "brighter", "1:1", [{
      bytes: new Uint8Array([0xff, 0xd8, 0xff]), mimeType: "image/jpeg", filename: "a.jpg",
    }])).resolves.toEqual({
      kind: "result",
      state: {
        status: "succeeded",
        progress: 100,
        resultUrl: null,
        resultBase64: "aW1hZ2U=",
        errorCode: null,
      },
    });
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://apimaster.example/v1/images/generations/async");
    const imageBody = fetcher.mock.calls[0]?.[1]?.body;
    expect(typeof imageBody === "string" ? JSON.parse(imageBody) as unknown : null).toMatchObject({ n: 1, resolution: "1K", size: "16:9" });
    const form = fetcher.mock.calls[1]?.[1]?.body;
    expect(fetcher.mock.calls[1]?.[0]).toBe("https://apimaster.example/v1/images/edits");
    expect(form).toBeInstanceOf(FormData);
    expect((form as FormData).getAll("image")).toHaveLength(1);

    await expect(client.submitImage("key", "gpt-image-2", "combine", "1:1", [{
      bytes: new Uint8Array([0xff, 0xd8, 0xff]), mimeType: "image/jpeg", filename: "a.jpg",
    }, {
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), mimeType: "image/png", filename: "b.png",
    }])).resolves.toMatchObject({
      kind: "result",
      state: { resultUrl: "https://cdn.example/edited.png", resultBase64: null },
    });
    const multipleForm = fetcher.mock.calls[2]?.[1]?.body;
    expect(fetcher.mock.calls[2]?.[0]).toBe("https://apimaster.example/v1/images/edits");
    expect(multipleForm).toBeInstanceOf(FormData);
    expect((multipleForm as FormData).getAll("image[]")).toHaveLength(2);
  });

  it("allows synchronous image edits to run for the documented three-minute timeout", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(new AbortController().signal);
    try {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({ data: [{ b64_json: "aW1hZ2U=" }] }),
      );
      const client = createClient(fetcher);
      await client.submitImage("key", "gpt-image-2", "edit", "1:1", [{
        bytes: new Uint8Array([0xff, 0xd8, 0xff]), mimeType: "image/jpeg", filename: "a.jpg",
      }]);
      expect(timeout).toHaveBeenCalledWith(180_000);
    } finally {
      timeout.mockRestore();
    }
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

  it("uses Responses for Grok 4.5 and translates messages to input", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      output: [{ type: "message", content: [{ type: "output_text", text: "你好，Grok" }] }],
    }));
    const client = createClient(fetcher);

    await expect(client.chat("user-api-key", "grok-4.5", "hello")).resolves.toBe("你好，Grok");
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe("https://apimaster.example/v1/responses");
    const requestBody: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    expect(requestBody).toMatchObject({
      model: "grok-4.5",
      instructions: MIA_SYSTEM_PROMPT,
      input: [{ role: "user", content: "hello" }],
      stream: false,
      store: false,
    });
  });

  it("retries Responses when an unknown model rejects Chat Completions by protocol", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ code: "protocol_not_supported", message: "model does not support chat completions" }, { status: 400 }))
      .mockResolvedValueOnce(Response.json({
        output: [{ type: "message", content: [{ type: "output_text", text: "response fallback" }] }],
      }));
    const client = createClient(fetcher);

    await expect(client.chat("user-api-key", "provider-response-model", "hello")).resolves.toBe("response fallback");
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      "https://apimaster.example/v1/chat/completions",
      "https://apimaster.example/v1/responses",
    ]);
  });

  it("uses Responses structured output with automatic Web Search and captures hidden search metadata", async () => {
    const output = {
      intent: "chat",
      confidence: 0.99,
      instruction: "",
      media_source: "none",
      image_options: null,
      video_options: null,
      final_response: "北京明天晴，最高 32℃。",
      conversation_mode: "task",
      onboarding_opportunity: false,
      profile_updates: null,
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      output: [
        { type: "web_search_call", status: "completed", action: { type: "search", query: "北京明天天气" } },
        {
          type: "message",
          content: [{
            type: "output_text",
            text: JSON.stringify(output),
            annotations: [{ type: "url_citation", url: "https://weather.example/beijing", title: "天气预报" }],
          }],
        },
      ],
    }));
    const client = createClient(fetcher);

    await expect(client.structuredResponse(
      "user-api-key",
      "gpt-5.4",
      [
        { role: "system", content: "system rules" },
        { role: "user", content: [
          { type: "text", text: "北京明天天气" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AQID" } },
        ] },
      ],
      "mia_media_intent",
      { type: "object" },
      30_000,
    )).resolves.toEqual({
      data: output,
      webSearch: {
        callCount: 1,
        queries: ["北京明天天气"],
        sources: [{ title: "天气预报", url: "https://weather.example/beijing" }],
      },
    });
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe("https://apimaster.example/v1/responses");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer user-api-key");
    const requestBody: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    expect(requestBody).toMatchObject({
      model: "gpt-5.4",
      instructions: "system rules",
      tools: [{ type: "web_search" }],
      tool_choice: "auto",
      text: { format: { type: "json_schema", name: "mia_media_intent", strict: true } },
      stream: false,
      store: false,
    });
    expect(JSON.stringify(requestBody)).toContain('"type":"input_image"');
    expect(JSON.stringify(requestBody)).not.toContain('"type":"image_url"');
  });

  it("can disable Web Search for lightweight structured participation decisions", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      output: [{
        type: "message",
        content: [{ type: "output_text", text: JSON.stringify({ should_respond: false }) }],
      }],
    }));
    const client = createClient(fetcher);

    await client.structuredResponse(
      "public-key",
      "gpt-5.4",
      [{ role: "user", content: "群成员之间的闲聊" }],
      "mia_follow_up_participation",
      { type: "object" },
      30_000,
      { webSearch: false },
    );

    const init = fetcher.mock.calls[0]?.[1];
    const requestBody = typeof init?.body === "string"
      ? JSON.parse(init.body) as Record<string, unknown>
      : {};
    expect(requestBody).not.toHaveProperty("tools");
    expect(requestBody).not.toHaveProperty("tool_choice");
  });

  it("uses Chat Completions for GPT-5.4 structured participation decisions", async () => {
    const decision = {
      should_respond: false,
      response_to_message_id: null,
      intent_hint: "chat",
      needs_web_search: false,
      confidence: 0.98,
      reason: "group_members_are_talking_to_each_other",
    };
    const schema = {
      type: "object",
      additionalProperties: false,
      required: [
        "should_respond", "response_to_message_id", "intent_hint", "needs_web_search", "confidence", "reason",
      ],
      properties: {
        should_respond: { type: "boolean" },
        response_to_message_id: { type: ["integer", "null"] },
        intent_hint: { type: "string", enum: ["chat", "media_or_summary"] },
        needs_web_search: { type: "boolean" },
        confidence: { type: "number" },
        reason: { type: "string" },
      },
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      choices: [{ message: { content: JSON.stringify(decision) } }],
    }));
    const client = createClient(fetcher);

    await expect(client.structuredChat(
      "public-key",
      "gpt-5.4",
      [{ role: "user", content: "群成员之间的闲聊" }],
      "mia_follow_up_participation",
      schema,
      30_000,
    )).resolves.toEqual(decision);

    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe("https://apimaster.example/v1/chat/completions");
    const requestBody: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    expect(requestBody).toEqual({
      model: "gpt-5.4",
      messages: [{ role: "user", content: "群成员之间的闲聊" }],
      stream: false,
      temperature: 0,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "mia_follow_up_participation",
          strict: true,
          schema,
        },
      },
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
