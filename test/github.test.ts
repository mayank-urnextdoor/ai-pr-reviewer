import { describe, expect, it } from "vitest";
import { existingFingerprints, fetchDiff, getPullRequest, postReview, upsertSummaryComment } from "../src/github.js";
import { SUMMARY_MARKER } from "../src/format.js";
import { httpError, stubOctokit } from "./octokit-stub.js";

const pr = { owner: "o", repo: "r", number: 7, headSha: "abc", title: "t", body: "", draft: false };

describe("getPullRequest", () => {
  it("reads the current head SHA, title and body", async () => {
    const { octokit } = stubOctokit();
    expect(await getPullRequest(octokit, "o", "r", 7)).toEqual({
      owner: "o",
      repo: "r",
      number: 7,
      headSha: "headsha1234567",
      title: "Add div guard",
      body: "Fixes #1",
      draft: false,
    });
  });
});

describe("fetchDiff", () => {
  it("parses the unified diff", async () => {
    const { octokit, mocks } = stubOctokit();
    const { files, source } = await fetchDiff(octokit, pr);
    expect(source).toBe("diff");
    expect(files.map((f) => f.path)).toContain("src/math.ts");
    expect(mocks.listFiles).not.toHaveBeenCalled();
  });

  it("falls back to the files endpoint when the diff is too large", async () => {
    const { octokit } = stubOctokit({
      diff: httpError(406, "diff too large"),
      files: [
        { filename: "a.ts", status: "modified", patch: "@@ -1 +1 @@\n-x\n+y" },
        { filename: "b.ts", status: "renamed", previous_filename: "old-b.ts", patch: "@@ -1 +1,2 @@\n z\n+w" },
        { filename: "c.png", status: "added" },
        { filename: "d.ts", status: "removed", patch: "@@ -1 +0,0 @@\n-gone" },
      ],
    });
    const { files, source } = await fetchDiff(octokit, pr);
    expect(source).toBe("files");
    expect(files.map((f) => [f.path, f.status, f.binary])).toEqual([
      ["a.ts", "modified", false],
      ["b.ts", "renamed", false],
      ["c.png", "added", true],
      ["d.ts", "deleted", false],
    ]);
    expect(files[1]!.oldPath).toBe("old-b.ts");
  });

  it("rethrows other errors", async () => {
    const { octokit } = stubOctokit({ diff: httpError(500) });
    await expect(fetchDiff(octokit, pr)).rejects.toMatchObject({ status: 500 });
  });
});

describe("existingFingerprints", () => {
  it("collects markers from earlier review comments", async () => {
    const { octokit } = stubOctokit({
      reviewComments: [
        { body: "x\n<!-- ai-pr-reviewer:fp=aaaaaaaaaaaaaaaa -->" },
        { body: "a human comment" },
        { body: "<!-- ai-pr-reviewer:fp=bbbbbbbbbbbbbbbb -->" },
      ],
    });
    expect(await existingFingerprints(octokit, pr)).toEqual(new Set(["aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb"]));
  });
});

describe("postReview", () => {
  const comments = [{ path: "a.ts", line: 3, side: "RIGHT" as const, body: "c1" }];

  it("posts one COMMENT review with inline comments on the head commit", async () => {
    const { octokit, mocks } = stubOctokit();
    const result = await postReview(octokit, pr, "body", comments);
    expect(result).toEqual({ id: 99, url: expect.any(String), inline: true });
    expect(mocks.createReview).toHaveBeenCalledWith(
      expect.objectContaining({ commit_id: "abc", event: "COMMENT", body: "body", comments }),
    );
  });

  it("moves comments into the body when GitHub rejects their positions", async () => {
    const { octokit, mocks } = stubOctokit({ createReview: [httpError(422)] });
    const result = await postReview(octokit, pr, "body", comments);
    expect(result.inline).toBe(false);
    const retry = (mocks.createReview.mock.calls as unknown as Array<[Record<string, unknown>]>)[1]![0];
    expect(retry).not.toHaveProperty("comments");
    expect(retry.body).toContain("`a.ts` line 3");
  });

  it("does not hide permission errors", async () => {
    const { octokit } = stubOctokit({ createReview: [httpError(403)] });
    await expect(postReview(octokit, pr, "body", comments)).rejects.toMatchObject({ status: 403 });
  });
});

describe("upsertSummaryComment", () => {
  it("creates a comment on the first run", async () => {
    const { octokit, mocks } = stubOctokit({ issueComments: [{ id: 1, body: "unrelated" }] });
    await upsertSummaryComment(octokit, pr, `${SUMMARY_MARKER}\nnew`);
    expect(mocks.createComment).toHaveBeenCalledOnce();
    expect(mocks.updateComment).not.toHaveBeenCalled();
  });

  it("updates the previous summary on later runs", async () => {
    const { octokit, mocks } = stubOctokit({ issueComments: [{ id: 42, body: `${SUMMARY_MARKER}\nold` }] });
    await upsertSummaryComment(octokit, pr, `${SUMMARY_MARKER}\nnew`);
    expect(mocks.updateComment).toHaveBeenCalledWith(expect.objectContaining({ comment_id: 42 }));
    expect(mocks.createComment).not.toHaveBeenCalled();
  });
});
