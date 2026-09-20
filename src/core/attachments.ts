import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { extname, join, resolve } from "node:path";
import type { JobAttachment } from "./types.js";

export type ImageAttachmentInput = {
  name?: unknown;
  mimeType?: unknown;
  base64?: unknown;
};

const MAX_IMAGES_PER_TASK = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp"
};

export class AttachmentStore {
  private readonly root: string;

  constructor(dataDirectory = ".jev") {
    this.root = resolve(dataDirectory, "attachments");
  }

  validate(input: unknown) {
    if (input === undefined) return;
    if (!Array.isArray(input)) throw new Error("Image attachments must be a list.");
    if (input.length > MAX_IMAGES_PER_TASK) throw new Error(`Attach at most ${MAX_IMAGES_PER_TASK} images to one task.`);
    for (const value of input) this.validateOne(value as ImageAttachmentInput);
  }

  saveForJob(jobId: string, input: unknown): JobAttachment[] {
    this.validate(input);
    if (input === undefined) return [];
    const directory = join(this.root, jobId);
    mkdirSync(directory, { recursive: true });
    return (input as unknown[]).map((value, index) => this.saveOne(directory, index, value as ImageAttachmentInput));
  }

  removeForJob(jobId: string) {
    rmSync(join(this.root, jobId), { recursive: true, force: true });
  }

  private saveOne(directory: string, index: number, input: ImageAttachmentInput): JobAttachment {
    this.validateOne(input);
    const extension = EXTENSIONS[input.mimeType as string];
    const bytes = Buffer.from(input.base64 as string, "base64");
    const id = randomUUID();
    const suppliedName = typeof input.name === "string" ? input.name.trim() : "";
    const name = suppliedName && suppliedName.length <= 180 ? suppliedName.replace(/[\\/\0]/g, "_") : `reference-${index + 1}${extension}`;
    const safeName = extname(name).toLowerCase() === extension ? name : `${name}${extension}`;
    const path = join(directory, `${id}${extension}`);
    writeFileSync(path, bytes, { flag: "wx" });
    return { id, name: safeName, mimeType: input.mimeType as string, path, size: bytes.length };
  }

  private validateOne(input: ImageAttachmentInput) {
    if (!input || typeof input !== "object" || typeof input.base64 !== "string" || typeof input.mimeType !== "string") {
      throw new Error("Each image needs a type and image data.");
    }
    const extension = EXTENSIONS[input.mimeType];
    if (!extension) throw new Error("Only PNG, JPEG, GIF, and WebP images can be attached to a task.");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(input.base64) || input.base64.length % 4 === 1) throw new Error("The image attachment is not valid base64 data.");
    const bytes = Buffer.from(input.base64, "base64");
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error("Each attached image must be between 1 byte and 5 MB.");
  }
}
