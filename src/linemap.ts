import type { DiffLine, FileDiff } from "./diff.js";

/**
 * Index of the head-side (RIGHT) lines that appear in the diff. GitHub only
 * accepts review comments on lines that are part of a hunk, so every finding
 * the model returns is checked against this index before it is posted.
 */
export interface CommentableLine {
  path: string;
  line: number;
  kind: "add" | "context";
  content: string;
  /** Index of the hunk within the file; multi-line comments must not span hunks. */
  hunk: number;
}

export class LineIndex {
  private readonly byPath = new Map<string, Map<number, CommentableLine>>();

  constructor(files: readonly FileDiff[]) {
    for (const file of files) {
      const lines = new Map<number, CommentableLine>();
      file.hunks.forEach((hunk, hunkIndex) => {
        for (const l of hunk.lines) {
          if (isRightSide(l)) {
            lines.set(l.newLine, { path: file.path, line: l.newLine, kind: l.kind, content: l.content, hunk: hunkIndex });
          }
        }
      });
      if (lines.size > 0) this.byPath.set(file.path, lines);
    }
  }

  hasFile(path: string): boolean {
    return this.byPath.has(path);
  }

  get(path: string, line: number): CommentableLine | undefined {
    return this.byPath.get(path)?.get(line);
  }

  isCommentable(path: string, line: number): boolean {
    return this.get(path, line) !== undefined;
  }

  /**
   * True when every line in [start, end] is a RIGHT-side line of the same
   * hunk. Within one hunk, head-side line numbers are contiguous, so this is
   * the condition for a valid multi-line comment or suggestion range.
   */
  isContiguousRange(path: string, start: number, end: number): boolean {
    if (start > end) return false;
    const first = this.get(path, start);
    if (!first) return false;
    for (let n = start; n <= end; n++) {
      const l = this.get(path, n);
      if (!l || l.hunk !== first.hunk) return false;
    }
    return true;
  }

  /** True when any line in the range was added by this PR. */
  rangeTouchesAddedLine(path: string, start: number, end: number): boolean {
    for (let n = start; n <= end; n++) {
      if (this.get(path, n)?.kind === "add") return true;
    }
    return false;
  }

  /** Text of the head-side lines in [start, end], joined with newlines. */
  rangeText(path: string, start: number, end: number): string {
    const out: string[] = [];
    for (let n = start; n <= end; n++) out.push(this.get(path, n)?.content ?? "");
    return out.join("\n");
  }

  paths(): string[] {
    return [...this.byPath.keys()];
  }
}

function isRightSide(l: DiffLine): l is DiffLine & { kind: "add" | "context"; newLine: number } {
  return l.kind !== "del" && l.newLine !== null;
}
