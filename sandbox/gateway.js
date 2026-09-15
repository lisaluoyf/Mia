import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { pathToFileURL } from "node:url";

const MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

export function parsePositiveInt(raw, fallback) {
  const parsed = Number.parseInt(String(raw || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function secureEqual(expected, actual) {
  const expectedBuffer = Buffer.from(String(expected || ""));
  const actualBuffer = Buffer.from(String(actual || ""));
  return expectedBuffer.length === actualBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

export function validateRequestBody(body, allowedModel) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return "request body must be a JSON object";
  }
  if (body.model !== allowedModel) {
    return "requested model is not allowed for this job";
  }
  return "";
}

export function upstreamURL(baseURL, pathname) {
  const base = new URL(baseURL.endsWith("/") ? baseURL : `${baseURL}/`);
  return new URL(pathname.replace(/^\/+/, ""), base).toString();
}

function jsonResponse(response, status, body) {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(encoded),
    "cache-control": "no-store",
  });
  response.end(encoded);
}

async function readBody(request, maxBytes = MAX_REQUEST_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("request body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function createGateway(options) {
  const {
    upstreamBaseURL,
    upstreamAPIKey,
    jobToken,
    allowedModel,
    expiresAt,
    maxRequests,
    fetchImpl = fetch,
  } = options;
  let requestCount = 0;

  return http.createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/healthz") {
      jsonResponse(response, 200, {
        ok: true,
        requests_remaining: Math.max(maxRequests - requestCount, 0),
      });
      return;
    }

    const suppliedToken = String(request.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!secureEqual(jobToken, suppliedToken)) {
      jsonResponse(response, 401, { error: { message: "invalid job token" } });
      return;
    }
    if (Date.now() >= expiresAt) {
      jsonResponse(response, 401, { error: { message: "job token expired" } });
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/responses") {
      jsonResponse(response, 404, { error: { message: "endpoint is not allowed" } });
      return;
    }
    if (requestCount >= maxRequests) {
      jsonResponse(response, 429, { error: { message: "job request limit reached" } });
      return;
    }

    let rawBody;
    let body;
    try {
      rawBody = await readBody(request);
      body = JSON.parse(rawBody.toString("utf8"));
    } catch (error) {
      jsonResponse(response, 400, { error: { message: error.message } });
      return;
    }
    const validationError = validateRequestBody(body, allowedModel);
    if (validationError) {
      jsonResponse(response, 403, { error: { message: validationError } });
      return;
    }

    requestCount += 1;
    const abortController = new AbortController();
    const timeout = setTimeout(
      () => abortController.abort(),
      Math.max(Math.min(expiresAt - Date.now(), 10 * 60 * 1000), 1),
    );
    try {
      const upstreamResponse = await fetchImpl(upstreamURL(upstreamBaseURL, "v1/responses"), {
        method: "POST",
        headers: {
          authorization: `Bearer ${upstreamAPIKey}`,
          "content-type": "application/json",
        },
        body: rawBody,
        signal: abortController.signal,
      });
      response.writeHead(upstreamResponse.status, {
        "content-type": upstreamResponse.headers.get("content-type") || "application/json",
        "cache-control": "no-store",
      });
      if (!upstreamResponse.body) {
        response.end();
        return;
      }
      let responseBytes = 0;
      for await (const chunk of upstreamResponse.body) {
        responseBytes += chunk.length;
        if (responseBytes > MAX_RESPONSE_BYTES) throw new Error("upstream response too large");
        response.write(chunk);
      }
      response.end();
    } catch (error) {
      if (!response.headersSent) {
        jsonResponse(response, 502, { error: { message: `upstream request failed: ${error.message}` } });
      } else {
        response.destroy(error);
      }
    } finally {
      clearTimeout(timeout);
    }
  });
}

function readSecret(path) {
  return fs.readFileSync(path, "utf8").trim();
}

function main() {
  const port = parsePositiveInt(process.env.PORT, 8080);
  const options = {
    upstreamBaseURL: process.env.APIMASTER_BASE_URL || "https://apimaster.ai/",
    upstreamAPIKey: readSecret(process.env.APIMASTER_API_KEY_FILE || "/run/secrets/apimaster_api_key"),
    jobToken: process.env.JOB_TOKEN || "",
    allowedModel: process.env.ALLOWED_MODEL || "",
    expiresAt: parsePositiveInt(process.env.JOB_EXPIRES_AT_MS, Date.now() + 10 * 60 * 1000),
    maxRequests: parsePositiveInt(process.env.MAX_REQUESTS, 24),
  };
  if (!options.jobToken || !options.allowedModel || !options.upstreamAPIKey) {
    throw new Error("JOB_TOKEN, ALLOWED_MODEL and APIMaster API key are required");
  }
  createGateway(options).listen(port, "0.0.0.0", () => {
    console.log(`Mia sandbox gateway listening on ${port}`);
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
