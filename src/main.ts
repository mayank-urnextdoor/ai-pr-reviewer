import * as core from "@actions/core";
import type * as github from "@actions/github";
import { chunkFiles } from "./chunk.js";
import { filterFiles } from "./filter.js";
import type { AnchoredFinding, Finding } from "./findings.js";
import { atLeast, highestSeverity, selectFindings } from "./findings.js";
import { fingerprint, formatSummary, toReviewComment } from "./format.js";
import type { Octokit, PostedReview, PullRequest } from "./github.js";
import { existingFingerprints, fetchDiff, getPullRequest, httpStatus, postReview, upsertSummaryComment } from "./github.js";
import type { Inputs } from "./inputs.js";
import { readInputs } from "./inputs.js";
import { LineIndex } from "./linemap.js";
import type { MessagesClient } from "./reviewer.js";
import { ClaudeReviewer } from "./reviewer.js";

export interface Environment {
  context: Pick<typeof github.context, "eventName" | "payload" | "repo">;
  createOctokit: (token: string) => Octokit;
  createClient: (apiKey: string) => MessagesClient;
}

const SUPPORTED_EVENTS = new Set(["pull_request", "pull_request_target"]);
const CONCURRENCY = 3;

export async function run(env: Environment): Promise<void> {
  try {
    await review(env);
  } catch (err) {
    core.setFailed(err instanceof Error ? err.message : String(err));
  }
}

async function review(env: Environment): Promise<void> {
  const inputs = readInputs((name) => core.getInput(name));
  // Register the key as a secret before anything can log it.
  if (inputs.anthropicApiKey) core.setSecret(inputs.anthropicApiKey);
  // Defaults for runs that skip (no key, draft, other event), so later steps
  // always see the documented values instead of empty strings.
  setOutputs(inputs, [], 0, null);

  const { context } = env;
  if (!SUPPORTED_EVENTS.has(context.eventName)) {
    core.warning(`ai-pr-reviewer only runs on pull_request events; got "${context.eventName}". Skipping.`);
    return;
  }
  if (context.eventName === "pull_request_target") {
    core.warning(
      "Running on pull_request_target: the job has write access and secrets while reviewing untrusted code. " +
        "This action never checks out or executes PR code, but read the Security section of the README.",
    );
  }
  if (!inputs.anthropicApiKey) {
    // Typical for PRs from forks: secrets are not passed to pull_request runs.
    core.warning(
      "No anthropic_api_key provided. Skipping review. Add an ANTHROPIC_API_KEY repository secret and pass it as " +
        "`anthropic_api_key`; secrets are not available to pull requests from forks.",
    );
    return;
  }
  const number = context.payload.pull_request?.number;
  if (typeof number !== "number") throw new Error("The event payload has no pull request number.");

  const octokit = env.createOctokit(inputs.githubToken);
  const pr = await getPullRequest(octokit, context.repo.owner, context.repo.repo, number);
  if (pr.draft && inputs.skipDrafts) {
    core.info("Pull request is a draft and skip_drafts is true. Skipping review.");
    return;
  }

  const { files, source } = await fetchDiff(octokit, pr);
  core.info(`Fetched ${files.length} changed file(s) via the ${source} endpoint.`);

  const filtered = filterFiles(files, inputs);
  const { chunks, skipped: chunkSkipped } = chunkFiles(filtered.kept, {
    maxTokensPerChunk: inputs.maxTokensPerChunk,
    maxChunks: inputs.maxChunks,
  });
  const skipped = [...filtered.skipped, ...chunkSkipped];
  core.info(`Reviewing ${filtered.kept.length} file(s) in ${chunks.length} request(s); ${skipped.length} skipped.`);

  const reviewer = new ClaudeReviewer(env.createClient(inputs.anthropicApiKey), {
    model: inputs.model,
    maxOutputTokens: inputs.maxOutputTokens,
    effort: inputs.effort,
    refusalFallback: inputs.refusalFallback,
    instructions: inputs.reviewInstructions,
    log: (m) => core.warning(m),
  });

  const findings: Finding[] = [];
  const summaries: string[] = [];
  const errors: string[] = [];
  const servedBy = new Set<string>();
  let invalid = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  await forEachLimit(chunks, CONCURRENCY, async (chunk, i) => {
    const label = chunks.length > 1 ? `Part ${i + 1}/${chunks.length}` : "Review";
    try {
      const result = await reviewer.review({
        title: pr.title,
        description: pr.body,
        part: i + 1,
        parts: chunks.length,
        files: chunk.files,
      });
      findings.push(...result.findings);
      if (result.summary) summaries[i] = result.summary;
      invalid += result.invalid;
      inputTokens += result.inputTokens;
      outputTokens += result.outputTokens;
      servedBy.add(result.servedBy);
      core.info(`${label}: ${result.findings.length} finding(s), ${result.inputTokens} input tokens.`);
    } catch (err) {
      const message = `${label} (${chunk.files.map((f) => f.path).join(", ")}): ${err instanceof Error ? err.message : String(err)}`;
      errors.push(message);
      core.warning(message);
    }
  });

  const index = new LineIndex(filtered.kept);
  const existing = inputs.dryRun ? new Set<string>() : await existingFingerprints(octokit, pr);
  const { kept, dropped, anchored } = selectFindings(findings, index, {
    severityThreshold: inputs.severityThreshold,
    maxComments: inputs.maxComments,
    existing,
    fingerprint,
  });

  const summaryBody = formatSummary({
    model: [...new Set([inputs.model, ...servedBy])].join(", "),
    summaries: summaries.filter(Boolean),
    posted: kept,
    total: anchored,
    filesReviewed: filtered.kept.length - chunkSkipped.filter((s) => s.reason === "over-budget").length,
    skipped,
    requests: chunks.length,
    inputTokens,
    outputTokens,
    dropped: { ...dropped, invalid },
    errors,
    headSha: pr.headSha,
  });

  let posted: PostedReview | null = null;
  if (inputs.dryRun) {
    core.info("dry_run is true: not posting to the pull request.");
  } else {
    posted = await publish(octokit, pr, kept, summaryBody);
  }

  await core.summary.addRaw(summaryBody, true).write();
  setOutputs(inputs, anchored, posted ? kept.length : 0, posted);

  if (chunks.length > 0 && errors.length === chunks.length) {
    core.setFailed("Every review request failed; see the warnings above.");
    return;
  }
  const worst = highestSeverity(anchored);
  if (inputs.failOn !== "none" && worst !== null && atLeast(worst, inputs.failOn)) {
    core.setFailed(`Found ${worst}-severity issue(s); fail_on is "${inputs.failOn}".`);
  }
}

/**
 * Post the review and summary. With a read-only token (the default for
 * pull_request from forks, or when the workflow does not grant
 * `pull-requests: write`) fall back to workflow annotations and the job
 * summary so the results are still visible.
 */
async function publish(
  octokit: Octokit,
  pr: PullRequest,
  kept: readonly AnchoredFinding[],
  summaryBody: string,
): Promise<PostedReview | null> {
  try {
    let review: PostedReview | null = null;
    if (kept.length > 0) {
      const body = `Automated review: ${kept.length} new comment(s). See the summary comment for details.`;
      review = await postReview(octokit, pr, body, kept.map(toReviewComment));
      core.info(`Posted review ${review.url}${review.inline ? "" : " (comments in review body)"}.`);
    }
    const url = await upsertSummaryComment(octokit, pr, summaryBody);
    core.info(`Summary comment: ${url}`);
    return review ?? { id: 0, url, inline: true };
  } catch (err) {
    const status = httpStatus(err);
    if (status !== 403 && status !== 404) throw err;
    core.warning(
      "The GitHub token cannot write to this pull request (grant `pull-requests: write`). " +
        "Reporting findings as annotations and in the job summary instead.",
    );
    for (const f of kept) {
      core.warning(`${f.title}\n\n${f.message}`, {
        title: `[${f.severity}] ${f.category}`,
        file: f.file,
        startLine: f.start_line ?? f.line,
        endLine: f.line,
      });
    }
    return null;
  }
}

function setOutputs(inputs: Inputs, all: readonly AnchoredFinding[], postedCount: number, posted: PostedReview | null) {
  core.setOutput("findings_count", all.length);
  core.setOutput("comments_posted", postedCount);
  core.setOutput("highest_severity", highestSeverity(all) ?? "none");
  core.setOutput("review_id", posted && posted.id !== 0 ? String(posted.id) : "");
  core.setOutput("model", inputs.model);
}

async function forEachLimit<T>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<void>) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
