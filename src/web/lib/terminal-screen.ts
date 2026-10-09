/** Renders common shell cursor and erase sequences into a bounded plain-text terminal screen. */
export class TerminalScreen {
  private lines: string[][] = [[]];
  private row = 0;
  private col = 0;
  private pending = "";
  private saved = [0, 0];
  readonly cols = 100;
  readonly rows = 24;

  /** Applies streamed output, retaining incomplete escape sequences between chunks. */
  write(data: string) {
    this.pending += data;
    let i = 0;
    while (i < this.pending.length) {
      const char = this.pending[i];
      if (char === "\x1b") {
        const rest = this.pending.slice(i);
        if (rest.length < 2) break;
        if (rest[1] === "[") {
          // ANSI cursor sequences contain control characters by design.
          // eslint-disable-next-line no-control-regex -- This parser must recognize terminal ESC sequences.
          const match = rest.match(/^\x1b\[([0-9;?]*)([ -/]*)([@-~])/);
          if (!match) { if (rest.length < 100) break; i++; continue; }
          const values = match[1].replace("?", "").split(";").map(Number);
          const n = values[0] || 1;
          const top = Math.max(0, this.lines.length - this.rows);
          switch (match[3]) {
            case "A": this.row = Math.max(top, this.row - n); break;
            case "B": this.row = Math.min(top + this.rows - 1, this.row + n); break;
            case "C": this.col = Math.min(this.cols - 1, this.col + n); break;
            case "D": this.col = Math.max(0, this.col - n); break;
            case "G": this.col = Math.min(this.cols - 1, n - 1); break;
            case "H": case "f": this.row = top + Math.min(this.rows - 1, n - 1); this.col = Math.min(this.cols - 1, (values[1] || 1) - 1); break;
            case "K": {
              const line = this.lines[this.row] ?? [];
              if (values[0] === 2) this.lines[this.row] = [];
              else if (values[0] === 1) for (let j = 0; j <= this.col; j++) line[j] = " ";
              else line.length = Math.min(line.length, this.col);
              break;
            }
            case "J": if (values[0] === 2 || values[0] === 3) { this.lines = [[]]; this.row = 0; this.col = 0; } else { this.lines.length = this.row + 1; const line = this.lines[this.row] ?? []; line.length = Math.min(line.length, this.col); } break;
            case "s": this.saved = [this.row, this.col]; break;
            case "u": [this.row, this.col] = this.saved; break;
          }
          i += match[0].length; continue;
        }
        if (rest[1] === "]") {
          // OSC sequences terminate at BEL or ESC-backslash.
          // eslint-disable-next-line no-control-regex -- BEL and ESC are terminal control characters.
          const end = rest.match(/^\x1b\][\s\S]*?(?:\x07|\x1b\\)/);
          if (!end) { if (rest.length > 4096) i = this.pending.length; break; }
          i += end[0].length; continue;
        }
        i += 2; continue;
      }
      i++;
      if (char === "\r") this.col = 0;
      else if (char === "\n") { this.row++; this.lines[this.row] ??= []; }
      else if (char === "\b") this.col = Math.max(0, this.col - 1);
      else if (char === "\t") this.col = Math.min(this.cols - 1, (Math.floor(this.col / 8) + 1) * 8);
      else if (char >= " " && char !== "\x7f") {
        if (this.col >= this.cols) { this.row++; this.col = 0; }
        const line = this.lines[this.row] ??= [];
        while (line.length < this.col) line.push(" ");
        line[this.col++] = char;
      }
      if (this.lines.length > 1000) { const excess = this.lines.length - 1000; this.lines.splice(0, excess); this.row -= excess; }
    }
    this.pending = this.pending.slice(i);
  }

  /** Returns safe text for rendering without interpreting HTML or terminal hyperlinks. */
  text() { return this.lines.map(line => line.join("")).join("\n"); }
}
