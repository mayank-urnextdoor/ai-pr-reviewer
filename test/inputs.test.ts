import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL, InputError, readInputs } from "../src/inputs.js";

const getter = (values: Record<string, string>) => (name: string) => values[name] ?? "";

describe("readInputs", () => {
  it("applies defaults", () => {
    const inputs = readInputs(getter({ anthropic_api_key: "sk-test", github_token: "ghs" }));
    expect(inputs).toMatchObject({
      model: DEFAULT_MODEL,
      include: [],
      exclude: [],
      skipGenerated: true,
      maxComments: 20,
      severityThreshold: "medium",
      failOn: "none",
      maxTokensPerChunk: 30_000,
      maxChunks: 10,
      maxOutputTokens: 16_000,
      effort: null,
      refusalFallback: true,
      skipDrafts: true,
      dryRun: false,
    });
    expect(DEFAULT_MODEL).toBe("claude-sonnet-5-5");
  });

  it("parses explicit values", () => {
    const inputs = readInputs(
      getter({
        model: "claude-opus-5-5",
        include: "src/**\nlib/**",
        exclude: "**/*.test.ts, docs/**",
        max_comments: "5",
        severity_threshold: "HIGH",
        fail_on: "critical",
        effort: "low",
        dry_run: "true",
        refusal_fallback: "false",
      }),
    );
    expect(inputs).toMatchObject({
      model: "claude-opus-5-5",
      include: ["src/**", "lib/**"],
      exclude: ["**/*.test.ts", "docs/**"],
      maxComments: 5,
      severityThreshold: "high",
      failOn: "critical",
      effort: "low",
      dryRun: true,
      refusalFallback: false,
    });
  });

  it.each([
    ["max_comments", "-1"],
    ["max_comments", "101"],
    ["max_chunks", "1.5"],
    ["severity_threshold", "urgent"],
    ["fail_on", "always"],
    ["dry_run", "yes"],
    ["effort", "extreme"],
  ])("rejects %s=%s", (name, value) => {
    expect(() => readInputs(getter({ [name]: value }))).toThrow(InputError);
  });
});
