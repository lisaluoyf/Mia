import { describe, expect, it } from "vitest";

import { explicitVideoResolution, resolveVideoResolution } from "../src/telegram/bot.js";

const capabilities = {
  modes: ["text_to_video", "image_to_video"] as const,
  durationSeconds: { min: 4, max: 15, default: 4 },
  resolutions: ["768P", "2K"],
  defaultResolution: "768P",
  aspectRatios: ["1:1", "16:9", "9:16"],
  defaultAspectRatio: "16:9",
  maxReferenceImages: 10,
};

describe("Mia video resolution selection", () => {
  it("uses the model catalog default when the user did not specify a resolution", () => {
    expect(resolveVideoResolution(capabilities, null)).toBe("768P");
  });

  it("preserves the catalog spelling for an explicitly requested resolution", () => {
    expect(resolveVideoResolution(capabilities, "2k")).toBe("2K");
  });

  it("rejects a resolution that the selected model does not advertise", () => {
    expect(resolveVideoResolution(capabilities, "720p")).toBeNull();
  });

  it("does not treat a classifier-only resolution as an explicit user choice", () => {
    expect(explicitVideoResolution("基于这张图做一个视频")).toBeNull();
    expect(resolveVideoResolution(capabilities, explicitVideoResolution("基于这张图做一个视频"))).toBe("768P");
  });

  it("reads an explicitly requested resolution from the user's message", () => {
    expect(explicitVideoResolution("做一个 2k 视频")).toBe("2K");
  });
});
