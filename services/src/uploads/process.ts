import { createHash } from "node:crypto";
import { fileTypeFromBuffer } from "file-type";
import sharp from "sharp";
import { BLOCK_PX, GRID, MAX_UPLOAD_BYTES } from "../constants.js";

export const ALLOWED_INPUT_MIME = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"]);

export class UploadError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 413 | 415 = 400,
  ) {
    super(message);
  }
}

export interface ProcessedImage {
  bytes: Buffer;
  contentType: "image/png" | "image/webp";
  width: number;
  height: number;
  sha256: string; // hex of the final bytes
}

export const sha256Hex = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/**
 * Validate by magic bytes (never the filename/extension), then cover-resize/crop to
 * exactly w*10 × h*10 and re-encode (which also strips metadata and animation).
 */
export async function processUpload(
  input: Buffer,
  w: number,
  h: number,
  format: "png" | "webp" = "png",
): Promise<ProcessedImage> {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w > GRID || h > GRID) {
    throw new UploadError("w and h must be integers in 1..100 (block units)");
  }
  if (input.length === 0) throw new UploadError("empty file");
  if (input.length > MAX_UPLOAD_BYTES) throw new UploadError("file exceeds 5MB", 413);
  const ft = await fileTypeFromBuffer(input);
  if (!ft || !ALLOWED_INPUT_MIME.has(ft.mime)) {
    throw new UploadError(`unsupported file type${ft ? ` (${ft.mime})` : ""}; use png, jpeg, webp, gif or avif`, 415);
  }
  const width = w * BLOCK_PX, height = h * BLOCK_PX;
  let img = sharp(input, { animated: false, limitInputPixels: 50_000_000 })
    .rotate() // honor EXIF orientation before cropping
    .resize(width, height, { fit: "cover", position: "attention" });
  img = format === "webp" ? img.webp({ lossless: true }) : img.png({ compressionLevel: 9 });
  let bytes: Buffer;
  try {
    bytes = await img.toBuffer();
  } catch (e) {
    throw new UploadError(`could not decode image: ${(e as Error).message}`);
  }
  return { bytes, contentType: format === "webp" ? "image/webp" : "image/png", width, height, sha256: sha256Hex(bytes) };
}
