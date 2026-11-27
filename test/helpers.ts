import type { DiffLine, FileDiff, Hunk } from "../src/diff.js";

/** Build a modified file whose single hunk adds `added` lines starting at `start`. */
export function fileWithAdds(path: string, added: string[], start = 1, extra: Partial<FileDiff> = {}): FileDiff {
  const lines: DiffLine[] = added.map((content, i) => ({ kind: "add", content, oldLine: null, newLine: start + i }));
  const hunk: Hunk = {
    header: `@@ -${start},0 +${start},${added.length} @@`,
    oldStart: start,
    oldLines: 0,
    newStart: start,
    newLines: added.length,
    section: "",
    lines,
  };
  return { path, oldPath: null, status: "modified", binary: false, hunks: [hunk], ...extra };
}

/** A file with `count` separate one-line hunks, each `width` chars long. */
export function fileWithHunks(path: string, count: number, width: number): FileDiff {
  const hunks: Hunk[] = [];
  for (let i = 0; i < count; i++) {
    const line = i * 10 + 1;
    hunks.push({
      header: `@@ -${line},0 +${line},1 @@`,
      oldStart: line,
      oldLines: 0,
      newStart: line,
      newLines: 1,
      section: "",
      lines: [{ kind: "add", content: "x".repeat(width), oldLine: null, newLine: line }],
    });
  }
  return { path, oldPath: null, status: "modified", binary: false, hunks };
}
