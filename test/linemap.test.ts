import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseDiff } from "../src/diff.js";
import { LineIndex } from "../src/linemap.js";

const files = parseDiff(readFileSync(new URL("./fixtures/multi-file.diff", import.meta.url), "utf8"));
const index = new LineIndex(files);

describe("LineIndex", () => {
  it("indexes added and context lines on the head side", () => {
    expect(index.get("src/math.ts", 6)).toMatchObject({
      kind: "add",
      content: '  if (b === 0) throw new RangeError("division by zero");',
      hunk: 0,
    });
    expect(index.get("src/math.ts", 1)).toMatchObject({ kind: "context", hunk: 0 });
    expect(index.get("src/math.ts", 25)).toMatchObject({ kind: "add", content: "export const PI = 3.14;", hunk: 1 });
  });

  it("rejects lines outside any hunk", () => {
    expect(index.isCommentable("src/math.ts", 10)).toBe(false);
    expect(index.isCommentable("src/math.ts", 21)).toBe(false);
    expect(index.isCommentable("src/math.ts", 0)).toBe(false);
  });

  it("does not index deleted, binary or hunk-less files", () => {
    expect(index.hasFile("old/legacy.js")).toBe(false);
    expect(index.hasFile("assets/logo.png")).toBe(false);
    expect(index.hasFile("scripts/run.sh")).toBe(false);
    expect(index.hasFile("missing.ts")).toBe(false);
  });

  it("uses the new path for renamed files", () => {
    expect(index.isCommentable("src/b.ts", 1)).toBe(true);
    expect(index.hasFile("src/a.ts")).toBe(false);
  });

  it("accepts ranges inside a single hunk", () => {
    expect(index.isContiguousRange("src/math.ts", 5, 7)).toBe(true);
    expect(index.isContiguousRange("src/math.ts", 7, 7)).toBe(true);
  });

  it("rejects ranges that span hunks, leave the diff or are reversed", () => {
    expect(index.isContiguousRange("src/math.ts", 8, 22)).toBe(false);
    expect(index.isContiguousRange("src/math.ts", 9, 10)).toBe(false);
    expect(index.isContiguousRange("src/math.ts", 7, 5)).toBe(false);
  });

  it("reports whether a range touches added lines", () => {
    expect(index.rangeTouchesAddedLine("src/math.ts", 1, 4)).toBe(false);
    expect(index.rangeTouchesAddedLine("src/math.ts", 4, 5)).toBe(true);
  });

  it("returns the text of a range", () => {
    expect(index.rangeText("src/math.ts", 6, 7)).toBe(
      '  if (b === 0) throw new RangeError("division by zero");\n  return a / b;',
    );
  });
});
