import assert from "node:assert/strict";
import test from "node:test";

import {
  createGateway,
  parsePositiveInt,
  secureEqual,
  upstreamURL,
  validateRequestBody,
} from "./gateway.js";

test("parses positive integers", () => {
  assert.equal(parsePositiveInt("12", 3), 12);
  assert.equal(parsePositiveInt("0", 3), 3);
  assert.equal(parsePositiveInt("bad", 3), 3);
});

test("compares tokens without accepting different lengths", () => {
  assert.equal(secureEqual("job-secret", "job-secret"), true);
  assert.equal(secureEqual("job-secret", "job-secrex"), false);
  assert.equal(secureEqual("job-secret", "short"), false);
});

test("only allows the assigned model", () => {
  assert.equal(validateRequestBody({ model: "gpt-5.4" }, "gpt-5.4"), "");
  assert.match(validateRequestBody({ model: "other" }, "gpt-5.4"), /not allowed/);
});

test("builds the Responses upstream URL", () => {
  assert.equal(upstreamURL("https://apimaster.ai/", "v1/responses"), "https://apimaster.ai/v1/responses");
  assert.equal(upstreamURL("https://example.com/api/", "/v1/responses"), "https://example.com/api/v1/responses");
});

test("gateway rejects other endpoints and enforces request count", async (context) => {
  let upstreamCalls = 0;
  const server = createGateway({
    upstreamBaseURL: "https://apimaster.ai/",
    upstreamAPIKey: "real-key",
    jobToken: "job-token",
    allowedModel: "gpt-5.4",
    expiresAt: Date.now() + 60_000,
    maxRequests: 1,
    fetchImpl: async (_url, options) => {
      upstreamCalls += 1;
      assert.equal(options.headers.authorization, "Bearer real-key");
      return new Response(JSON.stringify({ id: "response" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const { port } = server.address();

  const unauthorized = await fetch(`http://127.0.0.1:${port}/v1/responses`, { method: "POST" });
  assert.equal(unauthorized.status, 401);

  const forbidden = await fetch(`http://127.0.0.1:${port}/v1/models`, {
    method: "POST",
    headers: { authorization: "Bearer job-token" },
  });
  assert.equal(forbidden.status, 404);

  const accepted = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: { authorization: "Bearer job-token", "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-5.4", input: "hello" }),
  });
  assert.equal(accepted.status, 200);

  const limited = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: { authorization: "Bearer job-token", "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-5.4", input: "again" }),
  });
  assert.equal(limited.status, 429);
  assert.equal(upstreamCalls, 1);
});
