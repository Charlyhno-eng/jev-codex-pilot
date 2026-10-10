import { afterEach, describe, expect, it, vi } from "vitest";
import { scheduleTextareaResize } from "../../src/web/lib/textarea-resize.js";

afterEach(() => vi.unstubAllGlobals());

function frames() {
  const callbacks: FrameRequestCallback[] = [];
  const request = vi.fn((callback: FrameRequestCallback) => { callbacks.push(callback); return callbacks.length; });
  vi.stubGlobal("requestAnimationFrame", request);
  return { request, flush: () => { const batch = callbacks.splice(0); for (const callback of batch) callback(0); } };
}

function textarea() {
  const measure = vi.fn(() => 120);
  const element = { isConnected: true, style: { height: "" }, get scrollHeight() { return measure(); } };
  return { element: element as unknown as HTMLTextAreaElement, measure };
}

describe("typing layout work", () => {
  it("coalesces rapid input events without measuring layout in the keystroke handler", () => {
    const frame = frames();
    const { element, measure } = textarea();
    for (let index = 0; index < 100; index++) scheduleTextareaResize(element);
    expect(measure).not.toHaveBeenCalled();
    expect(frame.request).toHaveBeenCalledTimes(1);
    frame.flush();
    expect(measure).toHaveBeenCalledTimes(1);
    expect(element.style.height).toBe("120px");
    scheduleTextareaResize(element);
    frame.flush();
    expect(measure).toHaveBeenCalledTimes(2);
  });

  it("does not measure a draft removed or replaced before the animation frame", () => {
    const frame = frames();
    const { element, measure } = textarea();
    scheduleTextareaResize(element);
    Object.defineProperty(element, "isConnected", { value: false });
    frame.flush();
    expect(measure).not.toHaveBeenCalled();
  });

  it("resizes independently edited drafts within the same frame", () => {
    const frame = frames();
    const first = textarea();
    const second = textarea();
    scheduleTextareaResize(first.element);
    scheduleTextareaResize(second.element);
    frame.flush();
    expect(first.measure).toHaveBeenCalledTimes(1);
    expect(second.measure).toHaveBeenCalledTimes(1);
  });
});
