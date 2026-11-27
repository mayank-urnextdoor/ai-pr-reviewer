import { createHash } from "node:crypto";
import type { SkippedFile, SkipReason } from "./filter.js";
import type { AnchoredFinding, Severity } from "./findings.js";
import { SEVERITIES } from "./findings.js";

export const MARKER_PREFIX = "ai-pr-reviewer";
export const SUMMARY_MARKER = `<!-- ${MARKER_PREFIX}:summary -->`;
const FINGERPRINT_RE = new RegExp(`<!-- ${MARKER_PREFIX}:fp=([0-9a-f]{16}) -->`, "g");

/**
 * Fingerprint of a finding, stable across pushes: it depends on the file, the
 * category and the text of the anchored lines, not on line numbers (which
 * shift) or on the model's wording (which varies run to run).
 */
export function fingerprint(path: string, category: string, anchorText: string): string {
  const normalized = anchorText.replace(/\s+/g, " ").trim();
  return createHash("sha256").update(`${path}\n${category}\n${normalized}`).digest("hex").slice(0, 16);
}

export function extractFingerprints(body: string | null | undefined): string[] {
  if (!body) return [];
  return [...body.matchAll(FINGERPRINT_RE)].map((m) => m[1]!);
}

/**
 * Model output is untrusted (the diff it read may contain prompt-injection
 * text). Neutralize things that have side effects when GitHub renders them:
 * @-mentions notify people, and HTML comments could spoof our markers.
 */
export function sanitize(text: string): string {
  return text
    .replace(/<!--/g, "&lt;!--")
    .replace(/(^|[^\w`])@([A-Za-z0-9][\w-]*)/g, "$1@​$2")
    .trim();
}

/** Pick a code fence longer than any backtick run inside the content. */
export function fenceFor(content: string): string {
  const longest = Math.max(0, ...[...content.matchAll(/`+/g)].map((m) => m[0].length));
  return "`".repeat(Math.max(3, longest + 1));
}

const SEVERITY_LABEL: Record<Severity, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
};

export function formatComment(f: AnchoredFinding): string {
  const parts = [`**${SEVERITY_LABEL[f.severity]}** · ${f.category} · ${sanitize(f.title)}`, "", sanitize(f.message)];
  if (f.suggestion !== null) {
    // Suggestion text is code: keep it verbatim (no sanitizing), only fenced safely.
    const fence = fenceFor(f.suggestion);
    parts.push("", `${fence}suggestion`, f.suggestion.replace(/\n$/, ""), fence);
  }
  parts.push("", `<!-- ${MARKER_PREFIX}:fp=${f.fingerprint} -->`);
  return parts.join("\n");
}

export interface ReviewComment {
  path: string;
  line: number;
  side: "RIGHT";
  start_line?: number;
  start_side?: "RIGHT";
  body: string;
}

export function toReviewComment(f: AnchoredFinding): ReviewComment {
  const comment: ReviewComment = { path: f.file, line: f.line, side: "RIGHT", body: formatComment(f) };
  if (f.start_line !== null) {
    comment.start_line = f.start_line;
    comment.start_side = "RIGHT";
  }
  return comment;
}

const SKIP_LABEL: Record<SkipReason, string> = {
  binary: "binary",
  deleted: "deleted",
  "no-changes": "no added lines",
  lockfile: "lockfile",
  generated: "generated or vendored",
  excluded: "matched `exclude`",
  "not-included": "did not match `include`",
  "hunk-too-large": "a hunk exceeded `max_tokens_per_chunk` (partially reviewed)",
  "over-budget": "over `max_chunks` budget",
};

export interface SummaryInput {
  model: string;
  summaries: string[];
  posted: readonly AnchoredFinding[];
  /** All valid findings, including ones already posted on earlier runs. */
  total: readonly AnchoredFinding[];
  filesReviewed: number;
  skipped: readonly SkippedFile[];
  requests: number;
  inputTokens: number;
  outputTokens: number;
  dropped: { notInDiff: number; duplicate: number; belowThreshold: number; overLimit: number; invalid: number };
  errors: string[];
  headSha: string;
}

export function formatSummary(s: SummaryInput): string {
  const lines: string[] = [SUMMARY_MARKER, "## AI review", ""];

  const summaries = s.summaries.map(sanitize).filter((x) => x.length > 0);
  if (summaries.length === 1) lines.push(summaries[0]!, "");
  else if (summaries.length > 1) lines.push(...summaries.map((x) => `- ${x.replace(/\n+/g, " ")}`), "");

  if (s.total.length === 0) {
    lines.push("No issues found in the reviewed changes.", "");
  } else {
    lines.push("| Severity | Found | New comments |", "| --- | ---: | ---: |");
    for (const sev of SEVERITIES) {
      const found = s.total.filter((f) => f.severity === sev).length;
      const posted = s.posted.filter((f) => f.severity === sev).length;
      if (found > 0) lines.push(`| ${SEVERITY_LABEL[sev]} | ${found} | ${posted} |`);
    }
    lines.push("");
  }

  const notes: string[] = [];
  if (s.dropped.duplicate > 0) notes.push(`${s.dropped.duplicate} already commented on`);
  if (s.dropped.belowThreshold > 0) notes.push(`${s.dropped.belowThreshold} below \`severity_threshold\``);
  if (s.dropped.overLimit > 0) notes.push(`${s.dropped.overLimit} over \`max_comments\``);
  if (s.dropped.notInDiff > 0) notes.push(`${s.dropped.notInDiff} discarded (line not in the diff)`);
  if (s.dropped.invalid > 0) notes.push(`${s.dropped.invalid} discarded (malformed)`);
  if (notes.length > 0) lines.push(`Not posted: ${notes.join(", ")}.`, "");

  if (s.errors.length > 0) {
    lines.push("> [!WARNING]", `> ${s.errors.length} review request(s) failed, so part of the diff was not reviewed:`);
    for (const e of s.errors) lines.push(`> - ${sanitize(e).replace(/\n+/g, " ")}`);
    lines.push("");
  }

  if (s.skipped.length > 0) {
    lines.push(`<details><summary>${s.skipped.length} file(s) not reviewed</summary>`, "");
    for (const f of s.skipped) lines.push(`- \`${f.path}\`: ${SKIP_LABEL[f.reason]}`);
    lines.push("", "</details>", "");
  }

  lines.push(
    `<sub>${s.filesReviewed} file(s) reviewed in ${s.requests} request(s) · ` +
      `${s.inputTokens.toLocaleString("en-US")} input / ${s.outputTokens.toLocaleString("en-US")} output tokens · ` +
      `\`${s.model}\` · ${s.headSha.slice(0, 7)}. Automated review: verify before applying.</sub>`,
  );
  return lines.join("\n");
}
