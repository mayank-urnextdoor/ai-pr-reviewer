import { readFileSync } from "node:fs";
import { vi } from "vitest";
import type { Octokit } from "../src/github.js";

export const FIXTURE_DIFF = readFileSync(new URL("./fixtures/multi-file.diff", import.meta.url), "utf8");

export function httpError(status: number, message = `HTTP ${status}`): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

export interface StubOptions {
  diff?: string | Error;
  files?: Array<{ filename: string; status: string; patch?: string; previous_filename?: string }>;
  reviewComments?: Array<{ body: string }>;
  issueComments?: Array<{ id: number; body: string }>;
  draft?: boolean;
  createReview?: Array<Error | null>;
  createComment?: Error;
}

/** An in-memory stand-in for the parts of Octokit the action calls. */
export function stubOctokit(options: StubOptions = {}) {
  const pullsGet = vi.fn(async (params: { mediaType?: { format: string } }) => {
    if (params.mediaType?.format === "diff") {
      if (options.diff instanceof Error) throw options.diff;
      return { data: options.diff ?? FIXTURE_DIFF };
    }
    return {
      data: { head: { sha: "headsha1234567" }, title: "Add div guard", body: "Fixes #1", draft: options.draft ?? false },
    };
  });
  const listFiles = vi.fn(async () => ({ data: options.files ?? [] }));
  const listReviewComments = vi.fn(async () => ({ data: options.reviewComments ?? [] }));
  const reviewOutcomes = [...(options.createReview ?? [])];
  const createReview = vi.fn(async () => {
    const outcome = reviewOutcomes.shift();
    if (outcome) throw outcome;
    return { data: { id: 99, html_url: "https://github.com/o/r/pull/7#pullrequestreview-99" } };
  });
  const listComments = vi.fn(async () => ({ data: options.issueComments ?? [] }));
  const updateComment = vi.fn(async () => ({ data: { html_url: "https://github.com/o/r/pull/7#issuecomment-1" } }));
  const createComment = vi.fn(async () => {
    if (options.createComment) throw options.createComment;
    return { data: { html_url: "https://github.com/o/r/pull/7#issuecomment-2" } };
  });

  const octokit = {
    rest: {
      pulls: { get: pullsGet, listFiles, listReviewComments, createReview },
      issues: { listComments, updateComment, createComment },
    },
    paginate: vi.fn(async (method: (p: unknown) => Promise<{ data: unknown[] }>, params: unknown) => (await method(params)).data),
  };
  return {
    octokit: octokit as unknown as Octokit,
    mocks: { pullsGet, listFiles, listReviewComments, createReview, listComments, updateComment, createComment },
  };
}
