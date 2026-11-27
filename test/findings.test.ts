import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseDiff } from "../src/diff.js";
import type { Finding } from "../src/findings.js";
import {
  CATEGORIES,
  FindingSchema,
  REVIEW_JSON_SCHEMA,
  SEVERITIES,
  atLeast,
  highestSeverity,
  parseReviewJson,
  selectFindings,
} from "../src/findings.js";
import { fingerprint } from "../src/format.js";
import { LineIndex } from "../src/linemap.js";

const index = new LineIndex(parseDiff(readFileSync(new URL("./fixtures/multi-file.diff", import.meta.url), "utf8")));

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    file: "src/math.ts",
    line: 6,
    start_line: null,
    severity: "medium",
    category: "bug",
    title: "Title",
    message: "Message",
    suggestion: null,
    ...overrides,
  };
}

const baseOptions = { severityThreshold: "low" as const, maxComments: 50, existing: new Set<string>(), fingerprint };

describe("parseReviewJson", () => {
  it("parses a valid response", () => {
    const text = JSON.stringify({ summary: "  Adds div guard. ", findings: [finding()] });
    expect(parseReviewJson(text)).toEqual({ summary: "Adds div guard.", findings: [finding()], invalid: 0 });
  });

  it("drops malformed findings individually", () => {
    const text = JSON.stringify({
      summary: "s",
      findings: [finding(), { ...finding(), severity: "urgent" }, { ...finding(), line: -3 }, "nonsense"],
    });
    const result = parseReviewJson(text);
    expect(result.findings).toHaveLength(1);
    expect(result.invalid).toBe(3);
  });

  it("throws on invalid JSON or a wrong envelope", () => {
    expect(() => parseReviewJson("{not json")).toThrow(/not valid JSON/);
    expect(() => parseReviewJson(JSON.stringify({ findings: [] }))).toThrow(/wrong shape/);
  });
});

describe("REVIEW_JSON_SCHEMA", () => {
  it("lists the same fields, severities and categories as the zod schema", () => {
    const item = REVIEW_JSON_SCHEMA.properties.findings.items;
    expect([...item.required].sort()).toEqual(Object.keys(FindingSchema.shape).sort());
    expect(item.properties.severity.enum).toEqual([...SEVERITIES]);
    expect(item.properties.category.enum).toEqual([...CATEGORIES]);
  });

  it("disallows additional properties at every object level", () => {
    expect(REVIEW_JSON_SCHEMA.additionalProperties).toBe(false);
    expect(REVIEW_JSON_SCHEMA.properties.findings.items.additionalProperties).toBe(false);
  });
});

describe("selectFindings", () => {
  it("keeps findings on head-side diff lines", () => {
    const { kept, dropped } = selectFindings([finding()], index, baseOptions);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(dropped.notInDiff).toBe(0);
  });

  it("drops findings whose line is not in the diff or whose file is unknown", () => {
    const { kept, dropped } = selectFindings(
      [finding({ line: 12 }), finding({ file: "src/other.ts" }), finding({ file: "old/legacy.js", line: 1 })],
      index,
      baseOptions,
    );
    expect(kept).toEqual([]);
    expect(dropped.notInDiff).toBe(3);
  });

  it("tolerates ./ and a/ b/ prefixes on paths", () => {
    const { kept } = selectFindings(
      [finding({ file: "./src/math.ts" }), finding({ file: "b/src/b.ts", line: 1 })],
      index,
      baseOptions,
    );
    expect(kept.map((f) => f.file).sort()).toEqual(["src/b.ts", "src/math.ts"]);
  });

  it("keeps valid multi-line ranges", () => {
    const { kept } = selectFindings([finding({ start_line: 5, line: 7, suggestion: "x" })], index, baseOptions);
    expect(kept[0]).toMatchObject({ start_line: 5, line: 7, suggestion: "x" });
  });

  it("collapses ranges that leave the hunk and drops their suggestion", () => {
    const { kept } = selectFindings([finding({ start_line: 3, line: 23, suggestion: "x" })], index, {
      ...baseOptions,
    });
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ start_line: null, line: 23, suggestion: null });
  });

  it("drops a suggestion identical to the existing code", () => {
    const { kept } = selectFindings([finding({ line: 7, suggestion: "  return a / b;" })], index, baseOptions);
    expect(kept[0]!.suggestion).toBeNull();
  });

  it("dedupes repeated findings on the same lines", () => {
    const { kept, dropped } = selectFindings([finding(), finding({ title: "Same thing, reworded" })], index, baseOptions);
    expect(kept).toHaveLength(1);
    expect(dropped.duplicate).toBe(1);
  });

  it("skips findings already posted on an earlier run", () => {
    const first = selectFindings([finding()], index, baseOptions).kept[0]!;
    const { kept, dropped, anchored } = selectFindings([finding()], index, {
      ...baseOptions,
      existing: new Set([first.fingerprint]),
    });
    expect(kept).toEqual([]);
    expect(dropped.duplicate).toBe(1);
    expect(anchored).toHaveLength(1);
  });

  it("applies the severity threshold and max_comments, keeping the most severe", () => {
    const findings = [
      finding({ line: 1, severity: "low" }),
      finding({ line: 5, severity: "medium" }),
      finding({ line: 6, severity: "critical" }),
      finding({ line: 7, severity: "high" }),
    ];
    const { kept, dropped } = selectFindings(findings, index, {
      ...baseOptions,
      severityThreshold: "medium",
      maxComments: 2,
    });
    expect(kept.map((f) => f.severity)).toEqual(["critical", "high"]);
    expect(dropped).toEqual({ notInDiff: 0, duplicate: 0, belowThreshold: 1, overLimit: 1 });
  });
});

describe("severity helpers", () => {
  it("compares severities", () => {
    expect(atLeast("high", "medium")).toBe(true);
    expect(atLeast("low", "medium")).toBe(false);
    expect(atLeast("medium", "medium")).toBe(true);
  });

  it("finds the highest severity", () => {
    expect(highestSeverity([])).toBeNull();
    expect(highestSeverity([{ severity: "low" }, { severity: "high" }, { severity: "medium" }])).toBe("high");
  });
});
