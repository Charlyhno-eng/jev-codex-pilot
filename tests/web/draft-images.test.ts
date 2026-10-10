import { describe, expect, it, vi } from "vitest";
import { pasteDraftImages } from "../../src/web/lib/draft-images.js";

function imageItem(file: File | null, type = file?.type ?? "image/png") {
  return { kind: "file", type, getAsFile: () => file } as DataTransferItem;
}

function clipboard(items: DataTransferItem[], files: File[] = []) {
  return { clipboardData: { items, files } as unknown as DataTransfer, preventDefault: vi.fn() };
}

describe("ticket image paste", () => {
  it("attaches clipboard images once when both items and files contain them", () => {
    const image = new File(["image"], "screenshot.png", { type: "image/png" });
    const event = clipboard([imageItem(image)], [image]);
    const attach = vi.fn();
    pasteDraftImages(event, attach);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(attach).toHaveBeenCalledExactlyOnceWith([image]);
  });

  it("leaves text, image URLs, and non-image files to ordinary paste", () => {
    const event = clipboard([{ kind: "string", type: "text/plain" } as DataTransferItem, imageItem(new File(["text"], "note.txt", { type: "text/plain" }))]);
    const attach = vi.fn();
    pasteDraftImages(event, attach);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(attach).not.toHaveBeenCalled();
  });

  it("uses the files fallback when clipboard items do not yield a file", () => {
    const image = new File(["image"], "photo.jpg", { type: "image/jpeg" });
    const event = clipboard([imageItem(null)], [image]);
    const attach = vi.fn();
    pasteDraftImages(event, attach);
    expect(attach).toHaveBeenCalledExactlyOnceWith([image]);
  });

  it("passes every image through attachment validation, including unsupported types", () => {
    const images = ["image/png", "image/webp", "image/svg+xml"].map((type, index) => new File(["image"], `image-${index}`, { type }));
    const event = clipboard(images.map(file => imageItem(file)));
    const attach = vi.fn();
    pasteDraftImages(event, attach);
    expect(attach).toHaveBeenCalledExactlyOnceWith(images);
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });
});
