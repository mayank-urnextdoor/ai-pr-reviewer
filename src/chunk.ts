import type { FileDiff, Hunk } from "./diff.js";
import type { SkippedFile } from "./filter.js";

/**
 * Splits reviewable files into request-sized chunks.
 *
 * Token counts are estimated locally (no API call) with a deliberately
 * conservative chars-per-token ratio: code tokenizes denser than prose, and
 * overestimating only costs an extra request, while underestimating risks an
 * oversized one. Files are kept whole where possible so the model sees full
 * context for each file; a file larger than the budget is split on hunk
 * boundaries. A single hunk that alone exceeds the budget is skipped and
 * reported, never silently truncated.
 */

export const CHARS_PER_TOKEN = 3;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export interface Chunk {
  files: FileDiff[];
  tokens: number;
}

export interface ChunkOptions {
  /** Max estimated tokens of rendered diff per request. */
  maxTokensPerChunk: number;
  /** Max number of requests per run; files that do not fit are skipped. */
  maxChunks: number;
}

/** Render a file's hunks with head-side line numbers for the model. */
export function renderFile(file: FileDiff): string {
  const title =
    file.oldPath && file.oldPath !== file.path
      ? `### File: ${file.path} (${file.status} from ${file.oldPath})`
      : `### File: ${file.path} (${file.status})`;
  return [title, ...file.hunks.map(renderHunk)].join("\n");
}

export function renderHunk(hunk: Hunk): string {
  const width = String(hunk.newStart + hunk.newLines).length;
  const body = hunk.lines.map((l) => {
    const num = l.newLine === null ? " ".repeat(width) : String(l.newLine).padStart(width);
    const marker = l.kind === "add" ? "+" : l.kind === "del" ? "-" : " ";
    return `${num} ${marker}${l.content}`;
  });
  return [hunk.header, ...body].join("\n");
}

export function chunkFiles(
  files: readonly FileDiff[],
  options: ChunkOptions,
): { chunks: Chunk[]; skipped: SkippedFile[] } {
  const skipped: SkippedFile[] = [];
  const units: Array<{ file: FileDiff; tokens: number }> = [];

  for (const file of files) {
    const tokens = estimateTokens(renderFile(file));
    if (tokens <= options.maxTokensPerChunk) {
      units.push({ file, tokens });
      continue;
    }
    // Split an oversized file into parts made of whole hunks.
    let part: Hunk[] = [];
    let partTokens = 0;
    const header = estimateTokens(renderFile({ ...file, hunks: [] }));
    const flush = () => {
      if (part.length > 0) units.push({ file: { ...file, hunks: part }, tokens: header + partTokens });
      part = [];
      partTokens = 0;
    };
    let droppedHunk = false;
    for (const hunk of file.hunks) {
      const hunkTokens = estimateTokens(renderHunk(hunk)) + 1;
      if (header + hunkTokens > options.maxTokensPerChunk) {
        droppedHunk = true;
        continue;
      }
      if (header + partTokens + hunkTokens > options.maxTokensPerChunk) flush();
      part.push(hunk);
      partTokens += hunkTokens;
    }
    flush();
    if (droppedHunk) skipped.push({ path: file.path, reason: "hunk-too-large" });
  }

  // Greedy packing in original order, so related files tend to share a request.
  const chunks: Chunk[] = [];
  let current: Chunk = { files: [], tokens: 0 };
  for (const unit of units) {
    if (current.files.length > 0 && current.tokens + unit.tokens > options.maxTokensPerChunk) {
      chunks.push(current);
      current = { files: [], tokens: 0 };
    }
    current.files.push(unit.file);
    current.tokens += unit.tokens;
  }
  if (current.files.length > 0) chunks.push(current);

  if (chunks.length <= options.maxChunks) return { chunks, skipped };

  // Over the request cap: report everything past the cut-off. A file split
  // across the cut-off is reported too, since part of it went unreviewed.
  const dropped = new Set<string>();
  for (const chunk of chunks.slice(options.maxChunks)) {
    for (const f of chunk.files) {
      if (!dropped.has(f.path)) {
        dropped.add(f.path);
        skipped.push({ path: f.path, reason: "over-budget" });
      }
    }
  }
  return { chunks: chunks.slice(0, options.maxChunks), skipped };
}
