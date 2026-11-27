import { beforeEach, describe, expect, it, vi } from "vitest";

const inputs: Record<string, string> = {};
const outputs: Record<string, unknown> = {};
const coreMock = vi.hoisted(() => ({
  getInput: vi.fn(),
  setSecret: vi.fn(),
  setOutput: vi.fn(),
  setFailed: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  summary: { addRaw: vi.fn(), write: vi.fn() },
}));
vi.mock("@actions/core", () => coreMock);

import { fingerprint } from "../src/format.js";
import type { Environment } from "../src/main.js";
import { run } from "../src/main.js";
import type { MessagesClient } from "../src/reviewer.js";
import type { StubOptions } from "./octokit-stub.js";
import { httpError, stubOctokit } from "./octokit-stub.js";

const finding = (overrides: Record<string, unknown> = {}) => ({
  file: "src/math.ts",
  line: 6,
  start_line: null,
  severity: "high",
  category: "bug",
  title: "Guard uses the wrong error type",
  message: "Callers catch `TypeError`.",
  suggestion: null,
  ...overrides,
});

function modelReply(findings: unknown[], summary = "Adds a zero-division guard.") {
  return {
    model: "claude-sonnet-5-5",
    stop_reason: "end_turn",
    stop_details: null,
    content: [{ type: "text", text: JSON.stringify({ summary, findings }) }],
    usage: { input_tokens: 900, output_tokens: 120 },
  };
}

function setup(opts: { octokit?: StubOptions; replies?: unknown[]; eventName?: string } = {}) {
  const { octokit, mocks } = stubOctokit(opts.octokit);
  const create = vi.fn();
  for (const r of opts.replies ?? [modelReply([finding()])]) {
    if (r instanceof Error) create.mockRejectedValueOnce(r);
    else create.mockResolvedValueOnce(r);
  }
  const env: Environment = {
    context: {
      eventName: opts.eventName ?? "pull_request",
      payload: { pull_request: { number: 7 } },
      repo: { owner: "o", repo: "r" },
    },
    createOctokit: vi.fn(() => octokit),
    createClient: vi.fn(() => ({ beta: { messages: { create } } }) as unknown as MessagesClient),
  };
  return { env, mocks, create };
}

beforeEach(() => {
  for (const k of Object.keys(inputs)) delete inputs[k];
  for (const k of Object.keys(outputs)) delete outputs[k];
  Object.assign(inputs, { anthropic_api_key: "sk-ant-secret", github_token: "ghs_token" });
  coreMock.getInput.mockImplementation((name: string) => inputs[name] ?? "");
  coreMock.setOutput.mockImplementation((name: string, value: unknown) => {
    outputs[name] = value;
  });
  coreMock.summary.addRaw.mockReturnValue(coreMock.summary);
  coreMock.summary.write.mockResolvedValue(coreMock.summary);
});

describe("run", () => {
  it("reviews the PR, posts one review with inline comments and a summary", async () => {
    const { env, mocks, create } = setup({
      replies: [
        modelReply([
          finding(),
          finding({ line: 25, severity: "low", category: "readability", title: "Use Math.PI" }),
          finding({ line: 999, title: "Hallucinated line" }),
        ]),
      ],
    });
    await run(env);

    expect(coreMock.setFailed).not.toHaveBeenCalled();
    expect(coreMock.setSecret).toHaveBeenCalledWith("sk-ant-secret");
    expect(create).toHaveBeenCalledOnce();

    const reviewArgs = (mocks.createReview.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]![0];
    const comments = reviewArgs.comments as Array<{ path: string; line: number; body: string }>;
    // The low-severity finding is below the default "medium" threshold; line 999 is not in the diff.
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ path: "src/math.ts", line: 6, side: "RIGHT" });
    expect(reviewArgs).toMatchObject({ commit_id: "headsha1234567", event: "COMMENT" });

    const summary = (mocks.createComment.mock.calls as unknown as Array<[{ body: string }]>)[0]![0].body;
    expect(summary).toContain("Adds a zero-division guard.");
    expect(summary).toContain("1 discarded (line not in the diff)");
    expect(summary).toContain("1 below `severity_threshold`");
    expect(summary).not.toContain("sk-ant-secret");

    expect(outputs).toMatchObject({ findings_count: 2, comments_posted: 1, highest_severity: "high", review_id: "99" });
  });

  it("does not repost a finding that is already on the PR", async () => {
    const anchorText = '  if (b === 0) throw new RangeError("division by zero");';
    const fp = fingerprint("src/math.ts", "bug", anchorText.trim());
    const { env, mocks } = setup({
      octokit: {
        reviewComments: [{ body: `old\n<!-- ai-pr-reviewer:fp=${fp} -->` }],
        issueComments: [{ id: 5, body: "<!-- ai-pr-reviewer:summary -->\nold" }],
      },
    });
    await run(env);
    expect(mocks.createReview).not.toHaveBeenCalled();
    expect(mocks.updateComment).toHaveBeenCalledOnce();
    expect(outputs).toMatchObject({ findings_count: 1, comments_posted: 0 });
  });

  it("fails the job when fail_on is met, after posting", async () => {
    inputs.fail_on = "high";
    const { env, mocks } = setup();
    await run(env);
    expect(mocks.createReview).toHaveBeenCalledOnce();
    expect(coreMock.setFailed).toHaveBeenCalledWith(expect.stringContaining('fail_on is "high"'));
  });

  it("does not fail when findings are below fail_on", async () => {
    inputs.fail_on = "critical";
    const { env } = setup();
    await run(env);
    expect(coreMock.setFailed).not.toHaveBeenCalled();
  });

  it("posts nothing in dry_run mode but still writes the job summary", async () => {
    inputs.dry_run = "true";
    const { env, mocks } = setup();
    await run(env);
    expect(mocks.createReview).not.toHaveBeenCalled();
    expect(mocks.createComment).not.toHaveBeenCalled();
    expect(mocks.listReviewComments).not.toHaveBeenCalled();
    expect(coreMock.summary.write).toHaveBeenCalled();
    expect(outputs.comments_posted).toBe(0);
  });

  it("falls back to annotations when the token is read-only", async () => {
    const { env } = setup({ octokit: { createReview: [httpError(403, "Resource not accessible by integration")] } });
    await run(env);
    expect(coreMock.setFailed).not.toHaveBeenCalled();
    expect(coreMock.warning).toHaveBeenCalledWith(
      expect.stringContaining("Guard uses the wrong error type"),
      expect.objectContaining({ file: "src/math.ts", startLine: 6, endLine: 6 }),
    );
  });

  it("skips quietly when no API key is available (fork PRs)", async () => {
    inputs.anthropic_api_key = "";
    const { env, create } = setup();
    await run(env);
    expect(create).not.toHaveBeenCalled();
    expect(coreMock.setFailed).not.toHaveBeenCalled();
    expect(coreMock.warning).toHaveBeenCalledWith(expect.stringContaining("No anthropic_api_key"));
  });

  it("skips unsupported events and drafts", async () => {
    const push = setup({ eventName: "push" });
    await run(push.env);
    expect(push.env.createOctokit).not.toHaveBeenCalled();

    const draft = setup({ octokit: { draft: true } });
    await run(draft.env);
    expect(draft.create).not.toHaveBeenCalled();
  });

  it("reports a failed request in the summary and fails only if every request failed", async () => {
    const { env, mocks } = setup({ replies: [httpError(529, "overloaded")] });
    await run(env);
    const summary = (mocks.createComment.mock.calls as unknown as Array<[{ body: string }]>)[0]![0].body;
    expect(summary).toContain("overloaded");
    expect(coreMock.setFailed).toHaveBeenCalledWith(expect.stringContaining("Every review request failed"));
  });

  it("surfaces invalid inputs as a failed step", async () => {
    inputs.max_comments = "lots";
    const { env } = setup();
    await run(env);
    expect(coreMock.setFailed).toHaveBeenCalledWith(expect.stringContaining("max_comments"));
  });
});
