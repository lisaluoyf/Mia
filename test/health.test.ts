import { describe, expect, it } from "vitest";

import { createHealthServer } from "../src/health.js";
import { createLogger } from "../src/logger.js";

describe("health server", () => {
  it("reports readiness", async () => {
    const app = createHealthServer(createLogger("silent"));
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
    await app.close();
  });
});
