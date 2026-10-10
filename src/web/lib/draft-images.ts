import type { DraftAttachment } from "./types.js";

/** Reads an image attachment and keeps its preview out of the submitted API payload. */
export function readDraftImage(file: File): Promise<DraftAttachment> { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onerror = () => reject(reader.error); reader.onload = () => { const previewUrl = String(reader.result ?? ""); const base64 = previewUrl.split(",", 2)[1]; if (!base64) return reject(new Error("Missing image data")); resolve({ id: crypto.randomUUID(), name: file.name, mimeType: file.type, base64, previewUrl }); }; reader.readAsDataURL(file); }); }
