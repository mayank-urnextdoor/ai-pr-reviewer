import type * as github from "@actions/github";
import type { FileDiff, FileStatus } from "./diff.js";
import { parseDiff, parsePatch } from "./diff.js";
import type { ReviewComment } from "./format.js";
import { SUMMARY_MARKER, extractFingerprints } from "./format.js";

export type Octokit = ReturnType<typeof github.getOctokit>;

export interface PullRequest {
  owner: string;
  repo: string;
  number: number;
  headSha: string;
  title: string;
  body: string;
  draft: boolean;
}

/** HTTP status of an Octokit RequestError, if any. */
export function httpStatus(err: unknown): number | undefined {
  if (typeof err === "object" && err !== null && "status" in err && typeof err.status === "number") return err.status;
  return undefined;
}

export async function getPullRequest(octokit: Octokit, owner: string, repo: string, number: number): Promise<PullRequest> {
  const { data } = await octokit.rest.pulls.get({ owner, repo, pull_number: number });
  return {
    owner,
    repo,
    number,
    headSha: data.head.sha,
    title: data.title,
    body: data.body ?? "",
    draft: data.draft ?? false,
  };
}

/**
 * Fetch the PR as a unified diff. GitHub refuses diffs that are too large
 * (406/422 depending on the limit hit); in that case fall back to the
 * paginated files endpoint, which returns a patch per file (up to 3000 files,
 * omitting patches for binary and very large files).
 */
export async function fetchDiff(octokit: Octokit, pr: PullRequest): Promise<{ files: FileDiff[]; source: "diff" | "files" }> {
  try {
    const response = await octokit.rest.pulls.get({
      owner: pr.owner,
      repo: pr.repo,
      pull_number: pr.number,
      mediaType: { format: "diff" },
    });
    // With the diff media type the body is the raw diff text.
    return { files: parseDiff(response.data as unknown as string), source: "diff" };
  } catch (err) {
    const status = httpStatus(err);
    if (status !== 406 && status !== 422) throw err;
  }
  const items = await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner: pr.owner,
    repo: pr.repo,
    pull_number: pr.number,
    per_page: 100,
  });
  const files = items.map((f) => parsePatch(f.filename, f.patch, mapStatus(f.status), f.previous_filename ?? null));
  return { files, source: "files" };
}

function mapStatus(status: string): FileStatus {
  switch (status) {
    case "added":
      return "added";
    case "removed":
      return "deleted";
    case "renamed":
      return "renamed";
    case "copied":
      return "copied";
    default:
      return "modified";
  }
}

/** Fingerprints of findings already posted as review comments on this PR. */
export async function existingFingerprints(octokit: Octokit, pr: PullRequest): Promise<Set<string>> {
  const comments = await octokit.paginate(octokit.rest.pulls.listReviewComments, {
    owner: pr.owner,
    repo: pr.repo,
    pull_number: pr.number,
    per_page: 100,
  });
  return new Set(comments.flatMap((c) => extractFingerprints(c.body)));
}

export interface PostedReview {
  id: number;
  url: string;
  /** False when GitHub rejected the inline comments and they went into the body. */
  inline: boolean;
}

/**
 * Post one review containing all inline comments. If GitHub rejects the
 * batch (422, typically because the PR head moved after the diff was
 * fetched), post the findings in the review body instead of losing them.
 */
export async function postReview(
  octokit: Octokit,
  pr: PullRequest,
  body: string,
  comments: readonly ReviewComment[],
): Promise<PostedReview> {
  const base = { owner: pr.owner, repo: pr.repo, pull_number: pr.number, commit_id: pr.headSha, event: "COMMENT" as const };
  try {
    const { data } = await octokit.rest.pulls.createReview({ ...base, body, comments: [...comments] });
    return { id: data.id, url: data.html_url, inline: true };
  } catch (err) {
    if (httpStatus(err) !== 422 || comments.length === 0) throw err;
  }
  const fallbackBody = [
    body,
    "",
    "Inline comments could not be attached (the diff may have changed since it was fetched), so they are listed here:",
    "",
    ...comments.map((c) => `#### \`${c.path}\` line ${c.start_line ? `${c.start_line}-` : ""}${c.line}\n\n${c.body}`),
  ].join("\n");
  const { data } = await octokit.rest.pulls.createReview({ ...base, body: fallbackBody });
  return { id: data.id, url: data.html_url, inline: false };
}

/** Create the summary comment, or update the one left by a previous run. */
export async function upsertSummaryComment(octokit: Octokit, pr: PullRequest, body: string): Promise<string> {
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner: pr.owner,
    repo: pr.repo,
    issue_number: pr.number,
    per_page: 100,
  });
  const previous = comments.find((c) => c.body?.startsWith(SUMMARY_MARKER));
  if (previous) {
    const { data } = await octokit.rest.issues.updateComment({
      owner: pr.owner,
      repo: pr.repo,
      comment_id: previous.id,
      body,
    });
    return data.html_url;
  }
  const { data } = await octokit.rest.issues.createComment({
    owner: pr.owner,
    repo: pr.repo,
    issue_number: pr.number,
    body,
  });
  return data.html_url;
}
