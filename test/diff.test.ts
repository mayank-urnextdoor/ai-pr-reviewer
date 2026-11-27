import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseDiff, parseDiffGitHeader, parsePatch, unquote } from "../src/diff.js";

const fixture = readFileSync(new URL("./fixtures/multi-file.diff", import.meta.url), "utf8");

describe("parseDiff", () => {
  const files = parseDiff(fixture);
  const byPath = (p: string) => files.find((f) => f.path === p)!;

  it("finds every file in the diff", () => {
    expect(files.map((f) => f.path)).toEqual([
      "src/math.ts",
      "docs/new.md",
      "old/legacy.js",
      "src/b.ts",
      "assets/logo.png",
      "scripts/run.sh",
    ]);
  });

  it("parses hunk headers, including the section text", () => {
    const math = byPath("src/math.ts");
    expect(math.status).toBe("modified");
    expect(math.hunks).toHaveLength(2);
    expect(math.hunks[0]).toMatchObject({ oldStart: 1, oldLines: 7, newStart: 1, newLines: 9, section: "" });
    expect(math.hunks[1]).toMatchObject({
      oldStart: 20,
      oldLines: 3,
      newStart: 22,
      newLines: 4,
      section: "export function mul(a: number, b: number): number {",
    });
  });

  it("assigns old and new line numbers to each line", () => {
    const hunk = byPath("src/math.ts").hunks[0]!;
    const added = hunk.lines.filter((l) => l.kind === "add");
    expect(added.map((l) => l.newLine)).toEqual([5, 6, 7, 9]);
    expect(added.every((l) => l.oldLine === null)).toBe(true);

    const removed = hunk.lines.filter((l) => l.kind === "del");
    expect(removed.map((l) => l.oldLine)).toEqual([5, 6]);
    expect(removed.every((l) => l.newLine === null)).toBe(true);

    const lastContext = hunk.lines.filter((l) => l.kind === "context").at(-1)!;
    expect(lastContext).toMatchObject({ content: "}", oldLine: 7, newLine: 8 });
  });

  it("strips the diff marker from line content", () => {
    const hunk = byPath("src/math.ts").hunks[0]!;
    expect(hunk.lines[6]).toMatchObject({ kind: "add", content: "export function div(a: number, b: number): number {" });
    expect(hunk.lines[3]).toMatchObject({ kind: "context", content: "" });
  });

  it("handles new files and the no-newline marker", () => {
    const doc = byPath("docs/new.md");
    expect(doc.status).toBe("added");
    expect(doc.hunks[0]!.lines.map((l) => l.content)).toEqual(["# New doc", "Hello"]);
  });

  it("does not confuse a removed '-- text' line with a file header", () => {
    const legacy = byPath("old/legacy.js");
    expect(legacy.status).toBe("deleted");
    expect(legacy.hunks[0]!.lines).toHaveLength(2);
    expect(legacy.hunks[0]!.lines[1]).toMatchObject({ kind: "del", content: "-- this line starts with two dashes" });
  });

  it("tracks renames", () => {
    const renamed = byPath("src/b.ts");
    expect(renamed).toMatchObject({ status: "renamed", oldPath: "src/a.ts" });
    expect(renamed.hunks[0]!.lines.map((l) => l.kind)).toEqual(["del", "add"]);
  });

  it("flags binary files and keeps mode-only changes without hunks", () => {
    expect(byPath("assets/logo.png").binary).toBe(true);
    expect(byPath("assets/logo.png").hunks).toEqual([]);
    expect(byPath("scripts/run.sh")).toMatchObject({ binary: false, hunks: [], status: "modified" });
  });

  it("accepts CRLF line endings", () => {
    const crlf = parseDiff(fixture.replace(/\n/g, "\r\n"));
    expect(crlf.find((f) => f.path === "src/math.ts")!.hunks[0]!.lines).toHaveLength(
      byPath("src/math.ts").hunks[0]!.lines.length,
    );
  });

  it("parses a bare patch without a diff --git line", () => {
    const bare = ["--- a/x.txt", "+++ b/x.txt", "@@ -1 +1,2 @@", " one", "+two", ""].join("\n");
    const [file] = parseDiff(bare);
    expect(file).toMatchObject({ path: "x.txt", status: "modified" });
    expect(file!.hunks[0]!.lines.map((l) => l.newLine)).toEqual([1, 2]);
  });

  it("treats omitted hunk counts as 1", () => {
    const diff = ["diff --git a/f b/f", "--- a/f", "+++ b/f", "@@ -3 +3 @@", "-x", "+y", ""].join("\n");
    const hunk = parseDiff(diff)[0]!.hunks[0]!;
    expect(hunk).toMatchObject({ oldStart: 3, oldLines: 1, newStart: 3, newLines: 1 });
    expect(hunk.lines).toHaveLength(2);
  });

  it("stops at a truncated hunk instead of swallowing the next file", () => {
    const diff = [
      "diff --git a/a b/a",
      "--- a/a",
      "+++ b/a",
      "@@ -1,5 +1,5 @@",
      " only one line present",
      "diff --git a/b b/b",
      "--- a/b",
      "+++ b/b",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n");
    const files = parseDiff(diff);
    expect(files.map((f) => f.path)).toEqual(["a", "b"]);
    expect(files[1]!.hunks[0]!.lines).toHaveLength(2);
  });

  it("returns an empty list for an empty diff", () => {
    expect(parseDiff("")).toEqual([]);
  });
});

describe("parseDiffGitHeader", () => {
  it("splits simple paths", () => {
    expect(parseDiffGitHeader("a/src/x.ts b/src/x.ts")).toEqual({ oldPath: "src/x.ts", newPath: "src/x.ts" });
  });

  it("handles unquoted paths containing spaces", () => {
    expect(parseDiffGitHeader("a/my dir/b/c.ts b/my dir/b/c.ts")).toEqual({
      oldPath: "my dir/b/c.ts",
      newPath: "my dir/b/c.ts",
    });
  });

  it("handles quoted paths", () => {
    expect(parseDiffGitHeader('"a/caf\\303\\251.txt" "b/caf\\303\\251.txt"')).toEqual({
      oldPath: "café.txt",
      newPath: "café.txt",
    });
  });
});

describe("unquote", () => {
  it("decodes octal UTF-8 escapes and C escapes", () => {
    expect(unquote('"a\\tb\\"c\\\\"')).toBe('a\tb"c\\');
    expect(unquote('"\\346\\227\\245"')).toBe("日");
  });

  it("returns unquoted values unchanged", () => {
    expect(unquote("plain/path.ts")).toBe("plain/path.ts");
  });
});

describe("parsePatch", () => {
  it("parses the per-file patch format from pulls.listFiles", () => {
    const patch = "@@ -10,2 +10,3 @@ class A {\n   keep();\n+  added();\n   keep2();";
    const file = parsePatch("src/A.java", patch, "modified");
    expect(file.hunks).toHaveLength(1);
    expect(file.hunks[0]!.lines.map((l) => [l.kind, l.newLine])).toEqual([
      ["context", 10],
      ["add", 11],
      ["context", 12],
    ]);
  });

  it("marks files without a patch as binary", () => {
    expect(parsePatch("img.png", undefined, "added")).toMatchObject({ binary: true, hunks: [] });
  });
});
