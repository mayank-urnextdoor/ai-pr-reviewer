import { z } from "zod";
import type { LineIndex } from "./linemap.js";

export const SEVERITIES = ["critical", "high", "medium", "low"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const CATEGORIES = [
  "bug",
  "security",
  "performance",
  "reliability",
  "maintainability",
  "readability",
  "testing",
  "documentation",
] as const;
export type Category = (typeof CATEGORIES)[number];

const SEVERITY_RANK: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1 };

export function severityRank(s: Severity): number {
  return SEVERITY_RANK[s];
}

export function atLeast(s: Severity, threshold: Severity): boolean {
  return SEVERITY_RANK[s] >= SEVERITY_RANK[threshold];
}

/** One finding as returned by the model. */
export const FindingSchema = z.object({
  file: z.string().min(1),
  line: z.number().int().positive(),
  start_line: z.number().int().positive().nullable(),
  severity: z.enum(SEVERITIES),
  category: z.enum(CATEGORIES),
  title: z.string().min(1).max(200),
  message: z.string().min(1),
  suggestion: z.string().nullable(),
});
export type Finding = z.infer<typeof FindingSchema>;

/**
 * The response envelope. Findings are validated one by one afterwards so a
 * single malformed item does not discard the rest of the review.
 */
export const ReviewEnvelopeSchema = z.object({
  summary: z.string(),
  findings: z.array(z.unknown()),
});

/**
 * JSON Schema sent to the API as `output_config.format`. Kept by hand (rather
 * than generated) so it stays within the subset structured outputs accepts;
 * a test asserts that it matches the zod schema above.
 */
export const REVIEW_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "findings"],
  properties: {
    summary: {
      type: "string",
      description: "Two to four sentences on what the change does and its overall risk. No praise or filler.",
    },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["file", "line", "start_line", "severity", "category", "title", "message", "suggestion"],
        properties: {
          file: { type: "string", description: "Path exactly as shown in the '### File:' heading." },
          line: {
            type: "integer",
            description: "Head-side line number from the left column. Last line of the range for multi-line findings.",
          },
          start_line: {
            anyOf: [{ type: "integer" }, { type: "null" }],
            description: "First line of a multi-line range within the same hunk, or null for a single line.",
          },
          severity: { type: "string", enum: [...SEVERITIES] },
          category: { type: "string", enum: [...CATEGORIES] },
          title: { type: "string", description: "One-line summary of the problem." },
          message: { type: "string", description: "Why this is a problem and what to do. Markdown allowed." },
          suggestion: {
            anyOf: [{ type: "string" }, { type: "null" }],
            description:
              "Exact replacement text for lines start_line..line (or just line), without diff markers or line numbers. Null unless the fix is concrete and fully contained in those lines.",
          },
        },
      },
    },
  },
} as const;

export interface ParsedReview {
  summary: string;
  findings: Finding[];
  /** Items that did not match the schema. */
  invalid: number;
}

/** Parse and validate the model's JSON text. Throws on an unusable envelope. */
export function parseReviewJson(text: string): ParsedReview {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`Model output is not valid JSON: ${(err as Error).message}`, { cause: err });
  }
  const envelope = ReviewEnvelopeSchema.safeParse(raw);
  if (!envelope.success) {
    throw new Error(`Model output has the wrong shape: ${envelope.error.issues[0]?.message ?? "unknown"}`);
  }
  const findings: Finding[] = [];
  let invalid = 0;
  for (const item of envelope.data.findings) {
    const parsed = FindingSchema.safeParse(item);
    if (parsed.success) findings.push(parsed.data);
    else invalid++;
  }
  return { summary: envelope.data.summary.trim(), findings, invalid };
}

/** A finding that has been checked against the diff and can be posted. */
export interface AnchoredFinding extends Finding {
  /** Normalized: null, or strictly less than `line`. */
  start_line: number | null;
  /** Stable identifier used to avoid re-posting the same comment. */
  fingerprint: string;
}

export interface DropCounts {
  notInDiff: number;
  duplicate: number;
  belowThreshold: number;
  overLimit: number;
}

export interface SelectOptions {
  severityThreshold: Severity;
  maxComments: number;
  /** Fingerprints already present on the pull request. */
  existing: ReadonlySet<string>;
  fingerprint: (path: string, category: string, anchorText: string) => string;
}

/**
 * Keep only findings that can be posted: on a head-side diff line, with a
 * range that stays inside one hunk, at or above the severity threshold, not
 * already posted, and within `maxComments`. Ordered by severity, then path.
 */
export function selectFindings(
  findings: readonly Finding[],
  index: LineIndex,
  options: SelectOptions,
): { kept: AnchoredFinding[]; dropped: DropCounts; anchored: AnchoredFinding[] } {
  const dropped: DropCounts = { notInDiff: 0, duplicate: 0, belowThreshold: 0, overLimit: 0 };
  const anchored: AnchoredFinding[] = [];
  const seen = new Set<string>();

  for (const f of findings) {
    const file = resolvePath(f.file, index);
    if (!index.isCommentable(file, f.line)) {
      dropped.notInDiff++;
      continue;
    }
    let start = f.start_line !== null && f.start_line < f.line ? f.start_line : null;
    let suggestion = f.suggestion;
    if (start !== null && !index.isContiguousRange(file, start, f.line)) {
      // The range leaves the hunk: fall back to a single-line comment, and
      // drop the suggestion because it was written for the whole range.
      start = null;
      suggestion = null;
    }
    // A reversed range means the suggestion's extent is unclear.
    if (f.start_line !== null && f.start_line > f.line) suggestion = null;
    // A "suggestion" identical to the current code is noise.
    if (suggestion !== null && suggestion === index.rangeText(file, start ?? f.line, f.line)) suggestion = null;

    const anchorText = index.rangeText(file, start ?? f.line, f.line).trim();
    const fingerprint = options.fingerprint(file, f.category, anchorText);
    if (seen.has(fingerprint)) {
      dropped.duplicate++;
      continue;
    }
    seen.add(fingerprint);
    anchored.push({ ...f, file, start_line: start, suggestion, fingerprint });
  }

  anchored.sort(
    (a, b) => severityRank(b.severity) - severityRank(a.severity) || a.file.localeCompare(b.file) || a.line - b.line,
  );

  const kept: AnchoredFinding[] = [];
  for (const f of anchored) {
    if (!atLeast(f.severity, options.severityThreshold)) dropped.belowThreshold++;
    else if (options.existing.has(f.fingerprint)) dropped.duplicate++;
    else if (kept.length >= options.maxComments) dropped.overLimit++;
    else kept.push(f);
  }
  return { kept, dropped, anchored };
}

/**
 * Map the path the model returned onto a path in the diff. Tolerates "./",
 * backslashes and git's "a/" / "b/" prefixes, but only strips a prefix when
 * the unstripped path is not itself in the diff.
 */
function resolvePath(path: string, index: LineIndex): string {
  let p = path.trim().replaceAll("\\", "/");
  if (p.startsWith("./")) p = p.slice(2);
  if (!index.hasFile(p) && (p.startsWith("a/") || p.startsWith("b/")) && index.hasFile(p.slice(2))) {
    return p.slice(2);
  }
  return p;
}

export function highestSeverity(findings: readonly { severity: Severity }[]): Severity | null {
  let best: Severity | null = null;
  for (const f of findings) {
    if (best === null || severityRank(f.severity) > severityRank(best)) best = f.severity;
  }
  return best;
}
