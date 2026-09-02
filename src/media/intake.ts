import type { Api } from "grammy";
import sharp from "sharp";

import type { MediaBinary } from "../clients/apimaster.js";
import type { MediaInput } from "./types.js";

export const MAX_MEDIA_IMAGES = 10;
export const MAX_MEDIA_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_MEDIA_TOTAL_BYTES = 30 * 1024 * 1024;

export class MediaInputError extends Error {
  constructor(public readonly code: "too_many_images" | "file_too_large" | "total_too_large" | "invalid_image") {
    super(code);
    this.name = "MediaInputError";
  }
}

export function dataUrl(image: MediaBinary): string {
  return `data:${image.mimeType};base64,${Buffer.from(image.bytes).toString("base64")}`;
}

export async function downloadTelegramImages(
  api: Api,
  botToken: string,
  inputs: readonly MediaInput[],
  fetcher: typeof fetch = fetch,
): Promise<MediaBinary[]> {
  if (inputs.length > MAX_MEDIA_IMAGES) {
    throw new MediaInputError("too_many_images");
  }
  const images: MediaBinary[] = [];
  let originalTotal = 0;
  let processedTotal = 0;
  for (const [index, input] of inputs.entries()) {
    const file = await api.getFile(input.fileId);
    const declared = file.file_size ?? 0;
    if (declared > MAX_MEDIA_IMAGE_BYTES) {
      throw new MediaInputError("file_too_large");
    }
    if (originalTotal + declared > MAX_MEDIA_TOTAL_BYTES) {
      throw new MediaInputError("total_too_large");
    }
    if (!file.file_path) {
      throw new MediaInputError("invalid_image");
    }
    const response = await fetcher(`https://api.telegram.org/file/bot${botToken}/${file.file_path}`);
    if (!response.ok) {
      throw new MediaInputError("invalid_image");
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_MEDIA_IMAGE_BYTES) {
      throw new MediaInputError("file_too_large");
    }
    originalTotal += bytes.byteLength;
    if (originalTotal > MAX_MEDIA_TOTAL_BYTES) {
      throw new MediaInputError("total_too_large");
    }
    const headerMime = response.headers.get("content-type")?.split(";", 1)[0];
    const mimeType = input.mimeType ?? headerMime ?? sniffImageMime(bytes);
    if (!mimeType.startsWith("image/") || sniffImageMime(bytes) === "application/octet-stream") {
      throw new MediaInputError("invalid_image");
    }
    try {
      const source = sharp(bytes, { failOn: "error", limitInputPixels: 80_000_000 }).rotate();
      const metadata = await source.metadata();
      const normalized = metadata.hasAlpha
        ? await source.resize({ width: 4096, height: 4096, fit: "inside", withoutEnlargement: true }).png().toBuffer()
        : await source.resize({ width: 4096, height: 4096, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 92 }).toBuffer();
      processedTotal += normalized.byteLength;
      if (processedTotal > MAX_MEDIA_TOTAL_BYTES) throw new MediaInputError("total_too_large");
      images.push({
        bytes: new Uint8Array(normalized),
        mimeType: metadata.hasAlpha ? "image/png" : "image/jpeg",
        filename: `mia-input-${index + 1}.${metadata.hasAlpha ? "png" : "jpg"}`,
      });
    } catch (error) {
      if (error instanceof MediaInputError) throw error;
      throw new MediaInputError("invalid_image");
    }
  }
  return images;
}

function sniffImageMime(bytes: Uint8Array): string {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 12 && Buffer.from(bytes.slice(0, 4)).toString("ascii") === "RIFF" && Buffer.from(bytes.slice(8, 12)).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  if (bytes.length >= 6) {
    const signature = Buffer.from(bytes.slice(0, 6)).toString("ascii");
    if (signature === "GIF87a" || signature === "GIF89a") return "image/gif";
  }
  return "application/octet-stream";
}
