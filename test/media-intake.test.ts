import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";

import { downloadConversationImages, downloadTelegramImages } from "../src/media/intake.js";
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

  it("retries transient Telegram download failures", async () => {
    const source = await sharp({ create: { width: 4, height: 4, channels: 3, background: "red" } }).png().toBuffer();
    const api = { getFile: vi.fn().mockResolvedValue({ file_path: "docs/a.png", file_size: source.length }) };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("temporary failure", { status: 502 }))
      .mockResolvedValueOnce(new Response(source, { headers: { "content-type": "application/octet-stream" } }));

    const images = await downloadTelegramImages(api as never, "test-token", [{
      position: 0, messageId: 1, fileId: "file", fileUniqueId: null, type: "document", mimeType: "image/png", mediaGroupId: null,
    }], fetcher);

    expect(images).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("recognizes an image document from its bytes when Telegram uses a generic content type", async () => {
    const source = await sharp({ create: { width: 5, height: 5, channels: 3, background: "green" } }).png().toBuffer();
    const api = { getFile: vi.fn().mockResolvedValue({ file_path: "docs/a.png", file_size: source.length }) };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(source, {
      headers: { "content-type": "application/octet-stream" },
    }));

    const images = await downloadTelegramImages(api as never, "test-token", [{
      position: 0, messageId: 1, fileId: "file", fileUniqueId: null, type: "document", mimeType: null, mediaGroupId: null,
    }], fetcher);

    expect(images).toHaveLength(1);
    expect(images[0]?.mimeType).toBe("image/jpeg");
  });

  it("skips an invalid historical image without shifting later images", async () => {
    const first = await sharp({ create: { width: 4, height: 4, channels: 3, background: "red" } }).png().toBuffer();
    const third = await sharp({ create: { width: 6, height: 6, channels: 3, background: "blue" } }).png().toBuffer();
    const files = new Map([["first", first], ["bad", Buffer.from("not an image")], ["third", third]]);
    const api = { getFile: vi.fn((fileId: string) => Promise.resolve({ file_path: fileId, file_size: files.get(fileId)?.length })) };
    const fetcher = vi.fn<typeof fetch>((url) => {
      const value = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      return Promise.resolve(new Response(files.get(new URL(value).pathname.split("/").at(-1) ?? "")));
    });
    const inputs = ["first", "bad", "third"].map((fileId, index) => ({
      position: index, messageId: index + 1, fileId, fileUniqueId: null, type: "document" as const,
      mimeType: "image/png", mediaGroupId: null,
    }));

    const images = await downloadConversationImages(api as never, "test-token", inputs, new Set([1, 3]), fetcher);

    const widths = await Promise.all(images.map(async (image) => image
      ? (await sharp(image.bytes).metadata()).width
      : undefined));
    expect(widths).toEqual([4, undefined, 6]);
  });

  it("does not skip an invalid required image", async () => {
    const api = { getFile: vi.fn().mockResolvedValue({ file_path: "bad", file_size: 4 }) };
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(new Response("bad")));
    await expect(downloadConversationImages(api as never, "test-token", [{
      position: 0, messageId: 7, fileId: "bad", fileUniqueId: null, type: "document", mimeType: "image/png", mediaGroupId: null,
    }], new Set([7]), fetcher)).rejects.toEqual(expect.objectContaining<Partial<MediaInputError>>({ code: "invalid_image" }));
  });
});
