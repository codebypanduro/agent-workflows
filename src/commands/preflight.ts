// Deciding whether a run should start at all.
//
// Both of these run before the claim step, so a refusal leaves the object
// exactly as it was minus the trigger label — nothing was in progress, nothing
// failed, nothing was spent.

import { branchFor, type Config } from "../config.ts";
import { emit, gh, required, tryGh } from "../shared/common.ts";
import { agentLoginFor, fetchPullRequest, selectWork } from "../shared/pr-context.ts";
import { refuseImplement, refuseImplementPr } from "../shared/preflight.ts";

/** Closing keywords GitHub itself recognises in a pull request body. */
const CLOSES = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi;

function branchExists(repo: string, branch: string): boolean {
  // `gh api` has no -R; the path carries the repo. A 404 is the answer, not an
  // error, so the non-zero exit is caught rather than thrown.
  return tryGh(["api", `repos/${repo}/branches/${encodeURIComponent(branch)}`, "--silent"]).ok;
}

/** An open pull request whose body says it closes this issue. */
function existingPullRequest(repo: string, issueNumber: string): string | undefined {
  const listed = JSON.parse(
    gh(["pr", "list", "-R", repo, "--state", "open", "--limit", "100", "--json", "url,body"]),
  ) as { url: string; body: string }[];

  return listed.find((pr) => {
    for (const match of pr.body.matchAll(CLOSES)) {
      if (match[1] === issueNumber) return true;
    }
    return false;
  })?.url;
}

export async function preflightImplement(config: Config): Promise<void> {
  const repo = required("REPO");
  const issueNumber = required("ISSUE_NUMBER");
  const branch = branchFor(config, issueNumber);

  const refusal = refuseImplement(issueNumber, branch, {
    branchExists: branchExists(repo, branch),
    existingPullRequestUrl: existingPullRequest(repo, issueNumber),
  });

  emit({ proceed: refusal ? "false" : "true", reason: refusal?.reason ?? "", branch });
}

export async function preflightImplementPr(config: Config): Promise<void> {
  const repo = required("REPO");
  const prNumber = required("PR_NUMBER");
  const isOpen = process.env.PR_STATE !== "CLOSED" && process.env.PR_STATE !== "MERGED";

  const pr = fetchPullRequest(repo, prNumber, config.commitPrefix);
  const work = selectWork(pr, agentLoginFor(config, repo));

  const refusal = refuseImplementPr({
    isOpen,
    threadCount: work.threads.length,
    commentCount: work.comments.length,
  });

  emit({
    proceed: refusal ? "false" : "true",
    reason: refusal?.reason ?? "",
    branch: pr.headRefName,
  });
}
