import { describe, expect, it } from "vitest";
import type { AnchoredFinding } from "../src/findings.js";
import {
  SUMMARY_MARKER,
  extractFingerprints,
  fenceFor,
  fingerprint,
  formatComment,
  formatSummary,
  sanitize,
  toReviewComment,
} from "../src/format.js";

function anchored(overrides: Partial<AnchoredFinding> = {}): AnchoredFinding {
  return {
    file: "src/a.ts",
    line: 10,
    start_line: null,
    severity: "high",
    category: "bug",
    title: "Off-by-one in loop bound",
    message: "`i <= n` reads past the end of the array.",
    suggestion: null,
    fingerprint: "0123456789abcdef",
    ...overrides,
  };
}

describe("fingerprint", () => {
  it("is stable across whitespace changes and line moves", () => {
    expect(fingerprint("a.ts", "bug", "  x  =  1;")).toBe(fingerprint("a.ts", "bug", "x = 1;"));
  });

  it("differs by path, category and content", () => {
    const base = fingerprint("a.ts", "bug", "x");
    expect(fingerprint("b.ts", "bug", "x")).not.toBe(base);
    expect(fingerprint("a.ts", "security", "x")).not.toBe(base);
    expect(fingerprint("a.ts", "bug", "y")).not.toBe(base);
  });
});

describe("formatComment", () => {
  it("renders severity, category, title, message and a hidden marker", () => {
    const body = formatComment(anchored());
    expect(body).toBe(
      [
        "**High** · bug · Off-by-one in loop bound",
        "",
        "`i <= n` reads past the end of the array.",
        "",
        "<!-- ai-pr-reviewer:fp=0123456789abcdef -->",
      ].join("\n"),
    );
    expect(extractFingerprints(body)).toEqual(["0123456789abcdef"]);
  });

  it("adds a GitHub suggestion block when a fix is provided", () => {
    const body = formatComment(anchored({ suggestion: "for (let i = 0; i < n; i++) {\n" }));
    expect(body).toContain("```suggestion\nfor (let i = 0; i < n; i++) {\n```");
  });

  it("uses a longer fence when the suggestion contains backticks", () => {
    const body = formatComment(anchored({ suggestion: "const md = ```code```;" }));
    expect(body).toContain("````suggestion\nconst md = ```code```;\n````");
  });

  it("neutralizes mentions and marker spoofing in model text", () => {
    const body = formatComment(
      anchored({ title: "ping @octocat", message: "<!-- ai-pr-reviewer:fp=ffffffffffffffff --> see user@example.com" }),
    );
    expect(body).toContain("ping @​octocat");
    expect(body).toContain("user@example.com");
    expect(extractFingerprints(body)).toEqual(["0123456789abcdef"]);
  });
});

describe("sanitize and fenceFor", () => {
  it("leaves code spans with @ alone", () => {
    expect(sanitize("use `@Override`")).toBe("use `@Override`");
  });

  it("picks a fence of at least three backticks", () => {
    expect(fenceFor("no ticks")).toBe("```");
    expect(fenceFor("a ```` b")).toBe("`````");
  });
});

describe("toReviewComment", () => {
  it("maps single-line findings to RIGHT-side comments", () => {
    expect(toReviewComment(anchored())).toMatchObject({ path: "src/a.ts", line: 10, side: "RIGHT" });
    expect(toReviewComment(anchored())).not.toHaveProperty("start_line");
  });

  it("includes start_line for ranges", () => {
    expect(toReviewComment(anchored({ start_line: 8 }))).toMatchObject({
      start_line: 8,
      start_side: "RIGHT",
      line: 10,
    });
  });
});

describe("formatSummary", () => {
  const base = {
    model: "claude-sonnet-5-5",
    summaries: ["Adds a guard for division by zero."],
    posted: [anchored()],
    total: [anchored(), anchored({ severity: "low", fingerprint: "1111111111111111" })],
    filesReviewed: 3,
    skipped: [{ path: "yarn.lock", reason: "lockfile" as const }],
    requests: 1,
    inputTokens: 12345,
    outputTokens: 678,
    dropped: { notInDiff: 1, duplicate: 0, belowThreshold: 1, overLimit: 0, invalid: 0 },
    errors: [],
    headSha: "abcdef1234567890",
  };

  it("includes the marker, counts, skipped files and usage", () => {
    const body = formatSummary(base);
    expect(body.startsWith(SUMMARY_MARKER)).toBe(true);
    expect(body).toContain("Adds a guard for division by zero.");
    expect(body).toContain("| High | 1 | 1 |");
    expect(body).toContain("| Low | 1 | 0 |");
    expect(body).toContain("1 below `severity_threshold`");
    expect(body).toContain("1 discarded (line not in the diff)");
    expect(body).toContain("- `yarn.lock`: lockfile");
    expect(body).toContain("12,345 input / 678 output tokens");
    expect(body).toContain("abcdef1");
  });

  it("says so when nothing was found and lists request errors", () => {
    const body = formatSummary({ ...base, posted: [], total: [], errors: ["chunk 2: rate limited"] });
    expect(body).toContain("No issues found");
    expect(body).toContain("> - chunk 2: rate limited");
  });

  it("lists multiple chunk summaries as bullets", () => {
    const body = formatSummary({ ...base, summaries: ["One.", "Two."] });
    expect(body).toContain("- One.\n- Two.");
  });
});
