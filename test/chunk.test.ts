import { describe, expect, it } from "vitest";
import { chunkFiles, estimateTokens, renderFile } from "../src/chunk.js";
import type { FileDiff } from "../src/diff.js";
import { fileWithAdds, fileWithHunks } from "./helpers.js";

describe("renderFile", () => {
  it("prefixes head-side line numbers and leaves deleted lines unnumbered", () => {
    const file: FileDiff = {
      path: "src/a.ts",
      oldPath: null,
      status: "modified",
      binary: false,
      hunks: [
        {
          header: "@@ -8,2 +8,2 @@",
          oldStart: 8,
          oldLines: 2,
          newStart: 8,
          newLines: 2,
          section: "",
          lines: [
            { kind: "context", content: "a", oldLine: 8, newLine: 8 },
            { kind: "del", content: "b", oldLine: 9, newLine: null },
            { kind: "add", content: "c", oldLine: null, newLine: 9 },
          ],
        },
      ],
    };
    expect(renderFile(file)).toBe(
      ["### File: src/a.ts (modified)", "@@ -8,2 +8,2 @@", " 8  a", "   -b", " 9 +c"].join("\n"),
    );
  });

  it("mentions the previous path of renamed files", () => {
    const file = fileWithAdds("new.ts", ["x"], 1, { status: "renamed", oldPath: "old.ts" });
    expect(renderFile(file).split("\n")[0]).toBe("### File: new.ts (renamed from old.ts)");
  });
});

describe("chunkFiles", () => {
  it("packs small files into one chunk in order", () => {
    const files = [fileWithAdds("a.ts", ["1"]), fileWithAdds("b.ts", ["2"]), fileWithAdds("c.ts", ["3"])];
    const { chunks, skipped } = chunkFiles(files, { maxTokensPerChunk: 10_000, maxChunks: 5 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.files.map((f) => f.path)).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(skipped).toEqual([]);
  });

  it("never lets a chunk exceed the budget when files fit individually", () => {
    const files = Array.from({ length: 12 }, (_, i) => fileWithAdds(`f${i}.ts`, ["y".repeat(300)]));
    const budget = 400;
    const { chunks } = chunkFiles(files, { maxTokensPerChunk: budget, maxChunks: 100 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.tokens).toBeLessThanOrEqual(budget);
      expect(estimateTokens(c.files.map(renderFile).join("\n"))).toBeLessThanOrEqual(budget);
    }
    expect(chunks.flatMap((c) => c.files.map((f) => f.path))).toEqual(files.map((f) => f.path));
  });

  it("splits an oversized file on hunk boundaries", () => {
    const big = fileWithHunks("big.ts", 6, 270); // ~100 tokens per hunk
    const { chunks, skipped } = chunkFiles([big], { maxTokensPerChunk: 250, maxChunks: 10 });
    expect(skipped).toEqual([]);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flatMap((c) => c.files.flatMap((f) => f.hunks))).toHaveLength(6);
    expect(chunks.every((c) => c.files.every((f) => f.path === "big.ts"))).toBe(true);
  });

  it("skips (and reports) a single hunk larger than the budget", () => {
    const file = fileWithHunks("huge.ts", 2, 30);
    file.hunks[1]!.lines[0]!.content = "z".repeat(5_000);
    const { chunks, skipped } = chunkFiles([file], { maxTokensPerChunk: 200, maxChunks: 10 });
    expect(skipped).toEqual([{ path: "huge.ts", reason: "hunk-too-large" }]);
    expect(chunks.flatMap((c) => c.files.flatMap((f) => f.hunks))).toHaveLength(1);
  });

  it("caps the number of chunks and reports files past the cap", () => {
    const files = Array.from({ length: 5 }, (_, i) => fileWithAdds(`f${i}.ts`, ["q".repeat(600)]));
    const { chunks, skipped } = chunkFiles(files, { maxTokensPerChunk: 250, maxChunks: 2 });
    expect(chunks).toHaveLength(2);
    expect(skipped).toEqual([
      { path: "f2.ts", reason: "over-budget" },
      { path: "f3.ts", reason: "over-budget" },
      { path: "f4.ts", reason: "over-budget" },
    ]);
  });
});
