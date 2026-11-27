import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { buildSystemPrompt, buildUserPrompt, MAX_DESCRIPTION_CHARS } from "../src/prompt.js";
import type { MessagesClient, ReviewerOptions } from "../src/reviewer.js";
import { ClaudeReviewer, ReviewError } from "../src/reviewer.js";
import { fileWithAdds } from "./helpers.js";

const ctx = {
  title: "Add division guard",
  description: "Prevents divide by zero.",
  part: 1,
  parts: 1,
  files: [fileWithAdds("src/math.ts", ["if (b === 0) throw new Error();"], 5)],
};

const options: ReviewerOptions = {
  model: "claude-sonnet-5-5",
  maxOutputTokens: 16000,
  effort: null,
  refusalFallback: true,
  instructions: "",
};

function message(overrides: Record<string, unknown> = {}, text?: string) {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5-5",
    stop_reason: "end_turn",
    stop_details: null,
    content: [
      { type: "thinking", thinking: "", signature: "sig" },
      {
        type: "text",
        text:
          text ??
          JSON.stringify({
            summary: "Adds a guard.",
            findings: [
              {
                file: "src/math.ts",
                line: 5,
                start_line: null,
                severity: "low",
                category: "reliability",
                title: "Use RangeError",
                message: "A RangeError is more specific.",
                suggestion: "if (b === 0) throw new RangeError();",
              },
            ],
          }),
      },
    ],
    usage: { input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 50 },
    ...overrides,
  };
}

function stubClient(...responses: Array<unknown>) {
  const create = vi.fn();
  for (const r of responses) {
    if (r instanceof Error) create.mockRejectedValueOnce(r);
    else create.mockResolvedValueOnce(r);
  }
  const client = { beta: { messages: { create } } } as unknown as MessagesClient;
  return { client, create };
}

function badRequest(): Error {
  return new Anthropic.BadRequestError(400, { type: "error" }, "fallbacks not supported", new Headers());
}

describe("ClaudeReviewer", () => {
  it("sends the diff with a JSON schema output format and parses findings", async () => {
    const { client, create } = stubClient(message());
    const result = await new ClaudeReviewer(client, options).review(ctx);

    expect(result.findings).toHaveLength(1);
    expect(result.summary).toBe("Adds a guard.");
    expect(result.inputTokens).toBe(1050);
    expect(result.outputTokens).toBe(200);

    const params = create.mock.calls[0]![0];
    expect(params.model).toBe("claude-sonnet-5-5");
    expect(params.output_config.format.type).toBe("json_schema");
    expect(params.output_config).not.toHaveProperty("effort");
    expect(params.fallbacks).toBe("default");
    expect(params.betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect(params.messages[0].content).toContain("\n5 +if (b === 0) throw new Error();");
    expect(params).not.toHaveProperty("thinking");
  });

  it("passes effort when configured and omits fallbacks when disabled", async () => {
    const { client, create } = stubClient(message());
    await new ClaudeReviewer(client, { ...options, effort: "high", refusalFallback: false }).review(ctx);
    const params = create.mock.calls[0]![0];
    expect(params.output_config.effort).toBe("high");
    expect(params).not.toHaveProperty("fallbacks");
    expect(params).not.toHaveProperty("betas");
  });

  it("retries without fallbacks when the model rejects them, then stops sending them", async () => {
    const log = vi.fn();
    const { client, create } = stubClient(badRequest(), message(), message());
    const reviewer = new ClaudeReviewer(client, { ...options, log });
    await reviewer.review(ctx);
    await reviewer.review(ctx);
    expect(create).toHaveBeenCalledTimes(3);
    expect(create.mock.calls[1]![0]).not.toHaveProperty("fallbacks");
    expect(create.mock.calls[2]![0]).not.toHaveProperty("fallbacks");
    expect(log).toHaveBeenCalledOnce();
  });

  it("does not swallow other API errors", async () => {
    const err = new Anthropic.AuthenticationError(401, { type: "error" }, "bad key", new Headers());
    const { client } = stubClient(err);
    await expect(new ClaudeReviewer(client, options).review(ctx)).rejects.toBe(err);
  });

  it("reports refusals with their category", async () => {
    const { client } = stubClient(
      message({ stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: null } }),
    );
    await expect(new ClaudeReviewer(client, options).review(ctx)).rejects.toThrow(/declined.*cyber/);
  });

  it("reports truncated output", async () => {
    const { client } = stubClient(message({ stop_reason: "max_tokens" }, '{"summary": "x", "findi'));
    await expect(new ClaudeReviewer(client, options).review(ctx)).rejects.toBeInstanceOf(ReviewError);
  });

  it("reports unparseable output", async () => {
    const { client } = stubClient(message({}, "Sure! Here is my review."));
    await expect(new ClaudeReviewer(client, options).review(ctx)).rejects.toThrow(/not valid JSON/);
  });

  it("records which model served the response", async () => {
    const { client } = stubClient(message({ model: "claude-sonnet-5" }));
    expect((await new ClaudeReviewer(client, options).review(ctx)).servedBy).toBe("claude-sonnet-5");
  });
});

describe("prompts", () => {
  it("treats PR content as untrusted and appends maintainer instructions", () => {
    const system = buildSystemPrompt("Prefer early returns.");
    expect(system).toMatch(/untrusted input/);
    expect(system.endsWith("Prefer early returns.")).toBe(true);
    expect(buildSystemPrompt("  ")).not.toContain("Additional review guidelines");
  });

  it("marks partial reviews and truncates long descriptions explicitly", () => {
    const prompt = buildUserPrompt({ ...ctx, part: 2, parts: 3, description: "d".repeat(MAX_DESCRIPTION_CHARS + 10) });
    expect(prompt).toContain("part 2 of 3");
    expect(prompt).toContain(`[description truncated at ${MAX_DESCRIPTION_CHARS} characters]`);
    expect(prompt).toContain("### File: src/math.ts (modified)");
  });
});
