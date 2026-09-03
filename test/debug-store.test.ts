import { describe, expect, it, vi } from "vitest";

import { DebugRecorder } from "../src/debug/recorder.js";
import { DebugService } from "../src/debug/service.js";
import { DebugStore } from "../src/debug/store.js";
import { PROMPT_LIBRARY, promptReference } from "../src/prompts.js";
import { createLogger } from "../src/logger.js";
import { createServer } from "../src/server.js";
import { ContextStore } from "../src/storage/store.js";

describe("developer debug snapshots", () => {
  it("records only allowlisted Telegram users and redacts secrets and binary payloads", () => {
    const store = new DebugStore(":memory:");
    const recorder = new DebugRecorder(store, [42]);
    expect(recorder.start({ telegramUserId: 7, kind: "chat", model: "grok", requestPreview: "ignored" })).toBeNull();

    const id = recorder.start({
      telegramUserId: 42,
      kind: "chat",
      model: "grok-4.5",
      promptRefs: [promptReference("mia.system")],
      requestPreview: {
        authorization: "Bearer private",
        key: "api_key=sk-1234567890abcdef",
        image: "data:image/png;base64,aGVsbG8=",
        bytes: new Uint8Array([1, 2, 3]),
      },
    });
    expect(id).toBeTypeOf("string");
    recorder.finish(id, { status: "succeeded", responsePreview: "ok" });
    const request = store.list(42)[0];
    expect(JSON.stringify(request)).not.toContain("private");
    expect(JSON.stringify(request)).not.toContain("sk-1234567890abcdef");
    expect(JSON.stringify(request)).not.toContain("aGVsbG8=");
    expect(request?.status).toBe("succeeded");
    expect(store.list(7)).toEqual([]);
    store.close();
  });

  it("keeps only the newest configured number of snapshots per user", () => {
    const store = new DebugStore(":memory:", { maxPerUser: 2 });
    for (let index = 0; index < 3; index += 1) {
      store.start({ telegramUserId: 42, kind: "chat", model: `model-${index}` });
    }
    expect(store.list(42).map((item) => item.model)).toEqual(["model-2", "model-1"]);
    store.close();
  });

  it("exposes isolated internal routes, memory state, and the versioned prompt library", async () => {
    const debugStore = new DebugStore(":memory:");
    const contexts = new ContextStore(":memory:");
    contexts.upsertUser({ telegramUserId: 42, firstName: "Lisa", lastName: null, username: "lisa", languageCode: "en", isBot: false });
    contexts.addMemory({ scope: { type: "user", userId: 42 }, category: "identity", content: "Call the user Roma" });
    const requestId = debugStore.start({ telegramUserId: 42, kind: "chat", model: "grok-4.5" });
    const app = createServer({
      logger: createLogger("silent"),
      serviceKey: "test-internal-service-key",
      handleUpdate: vi.fn(),
      debug: new DebugService(debugStore, contexts),
    });
    const unauthorized = await app.inject({ method: "GET", url: "/internal/debug/requests?telegram_user_id=42" });
    expect(unauthorized.statusCode).toBe(404);
    const headers = { "x-mia-internal-key": "test-internal-service-key" };
    const requests = await app.inject({ method: "GET", url: "/internal/debug/requests?telegram_user_id=42", headers });
    expect(requests.body).toContain(requestId);
    const isolated = await app.inject({ method: "GET", url: `/internal/debug/requests/${requestId}?telegram_user_id=7`, headers });
    expect(isolated.statusCode).toBe(404);
    const memory = await app.inject({ method: "GET", url: "/internal/debug/memory?telegram_user_id=42", headers });
    expect(memory.body).toContain("Call the user Roma");
    const prompts = await app.inject({ method: "GET", url: "/internal/debug/prompts?telegram_user_id=42", headers });
    expect(prompts.body).toContain(PROMPT_LIBRARY[0]?.id);
    await app.close();
    contexts.close();
    debugStore.close();
  });
});
