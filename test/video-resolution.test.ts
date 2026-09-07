import { describe, expect, it } from "vitest";

import { resolveVideoResolution } from "../src/telegram/bot.js";

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
  it("leaves the resolution unset even when the catalog advertises a default", () => {
    expect(resolveVideoResolution(capabilities, null)).toBeUndefined();
    expect(resolveVideoResolution(capabilities, "  ")).toBeUndefined();
    expect(resolveVideoResolution({ ...capabilities, resolutions: ["720p"], defaultResolution: "720p" }, null)).toBeUndefined();
  });

  it("preserves the catalog spelling for an explicitly requested resolution", () => {
    expect(resolveVideoResolution(capabilities, "2k")).toBe("2K");
  });

  it("rejects a resolution that the selected model does not advertise", () => {
    expect(resolveVideoResolution(capabilities, "720p")).toBeNull();
  });

  it("defers defaults and explicit values to the channel when the catalog has no resolution metadata", () => {
    const unknown = { ...capabilities, resolutions: [], defaultResolution: "" };
    expect(resolveVideoResolution(unknown, null)).toBeUndefined();
    expect(resolveVideoResolution(unknown, "512p")).toBe("512p");
    expect(resolveVideoResolution(unknown, "2K")).toBe("2K");
    expect(resolveVideoResolution(unknown, "anything")).toBeNull();
  });
});
