import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";

import { downloadTelegramImages } from "../src/media/intake.js";
import type { MediaInputError } from "../src/media/intake.js";

describe("Telegram media intake", () => {
  it("decodes, rotates and preserves transparency as PNG", async () => {
    const source = await sharp({ create: { width: 4, height: 2, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .png().withMetadata({ orientation: 6 }).toBuffer();
    const api = { getFile: vi.fn().mockResolvedValue({ file_path: "photos/a.png", file_size: source.length }) };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(source, { headers: { "content-type": "image/png" } }));
    const [image] = await downloadTelegramImages(api as never, "test-token", [{
      position: 0, messageId: 1, fileId: "file", fileUniqueId: "unique", type: "photo", mimeType: "image/png", mediaGroupId: null,
    }], fetcher);
    expect(image?.mimeType).toBe("image/png");
    expect(await sharp(image?.bytes).metadata()).toMatchObject({ width: 2, height: 4 });
  });

  it("rejects deceptive non-image bytes before submission", async () => {
    const api = { getFile: vi.fn().mockResolvedValue({ file_path: "docs/a.png", file_size: 4 }) };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array([1, 2, 3, 4]), {
      headers: { "content-type": "image/png" },
    }));
    await expect(downloadTelegramImages(api as never, "test-token", [{
      position: 0, messageId: 1, fileId: "file", fileUniqueId: null, type: "document", mimeType: "image/png", mediaGroupId: null,
    }], fetcher)).rejects.toEqual(expect.objectContaining<Partial<MediaInputError>>({ code: "invalid_image" }));
  });
});
