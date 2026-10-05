import { describe, expect, it } from "vitest";
import { TerminalScreen } from "../../src/web/lib/terminal-screen.js";

describe("shell screen", () => {
  it("handles carriage-return progress updates and split ANSI sequences", () => {
    const screen = new TerminalScreen();
    screen.write("Loading 1%\r\x1b[");
    screen.write("KLoading 50%\r\x1b[KDone\r\n$ ");
    expect(screen.text()).toBe("Done\n$ ");
  });
  it("renders line editing and strips terminal colors and unsafe hyperlinks", () => {
    const screen = new TerminalScreen();
    screen.write("$ helo\x1b[2D\x1b[Kllo\x1b[31m!\x1b[0m\x1b]8;;https://example.com\x07link\x1b]8;;\x1b\\");
    expect(screen.text()).toBe("$ hello!link");
  });
  it("bounds retained scrollback", () => {
    const screen = new TerminalScreen();
    screen.write("line\r\n".repeat(1500));
    expect(screen.text().split("\n")).toHaveLength(1000);
  });
});
