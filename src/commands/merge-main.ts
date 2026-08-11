// Brings a pull request branch up to date with its base.
//
// Merge, never rebase. A rebase would detach every inline review comment from
// its line, and under this design those comments are the review workflow's
// entire output.
//
// A clean merge never starts an agent — there is nothing to decide. When there
// are conflicts the agent resolves them, verification runs with the same
// self-repair loop the implement workflows use, and the run leaves a comment
// naming every file it touched.

import * as sandcastle from "@ai-hero/sandcastle";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";
import type { Config } from "../config.ts";
import { materialisePrompt } from "../prompts.ts";
import { agent, configureGitIdentity, git, outputDir, report, required, tryGit, writeOutput } from "../shared/common.ts";
import { fetchPullRequest } from "../shared/pr-context.ts";
import { verifyWithRepair } from "../shared/verify.ts";

/** Whether a merge is actually in progress, so `--abort` is a legal move. */
function mergeInProgress(): boolean {
  return tryGit(["rev-parse", "--verify", "MERGE_HEAD"]).ok;
}

/** Files left with conflict markers by a failed merge. */
function conflictedFiles(): string[] {
  return git(["diff", "--name-only", "--diff-filter=U"])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function resolutionComment(files: readonly string[], runUrl: string): string {
  return [
    `Merged \`main\` into this branch. **${files.length} file(s) conflicted and were resolved by an agent:**`,
    "",
    files.map((file) => `- \`${file}\``).join("\n"),
    "",
    `Checks pass on the result, but a green suite does not prove the resolution kept the right side of each conflict — the tests that would have caught it may be on the side that lost. Read the merge commit before merging this pull request — [run log](${runUrl}).`,
  ].join("\n");
}

export async function mergeMain(config: Config): Promise<void> {
  const repo = required("REPO");
  const prNumber = required("PR_NUMBER");
  const runUrl = required("RUN_URL");

  const pr = fetchPullRequest(repo, prNumber, config.commitPrefix);
  const base = pr.baseRefName;

  configureGitIdentity(config);
  git(["fetch", "origin", base]);

  // Nothing to do is a real and common answer, and it should not cost an agent.
  const behind = git(["rev-list", "--count", `HEAD..origin/${base}`]).trim();
  if (behind === "0") {
    console.log(`\`${pr.headRefName}\` is already up to date with ${base}.`);
    report("already-current");
    return;
  }

  console.log(`\`${pr.headRefName}\` is ${behind} commit(s) behind ${base}. Merging.\n`);

  const merge = tryGit(["merge", "--no-edit", `origin/${base}`]);
  if (merge.ok) {
    // A clean merge changes no decisions, so it needs no agent and no
    // verification beyond what the project's own CI runs on the push.
    console.log("Merged cleanly — no conflicts.");
    writeOutput("should_push.txt", "true");
    report("merged", "0");
    return;
  }

  const conflicts = conflictedFiles();
  if (conflicts.length === 0) {
    // Merge failed for some reason other than conflicts — a dirty tree, a
    // shallow ref with no common ancestor, a missing branch. Not something an
    // agent should paper over.
    //
    // Abort only if there is actually a merge in progress, and never let its
    // failure become the reported error: `--abort` with no MERGE_HEAD throws
    // "there is no merge to abort", which would replace the message that
    // explains what really went wrong.
    if (mergeInProgress()) tryGit(["merge", "--abort"]);
    throw new Error(`git merge failed without producing conflicts:\n${merge.output.trim()}`);
  }

  console.log(`${conflicts.length} conflicted file(s):\n${conflicts.map((f) => `  ${f}`).join("\n")}\n`);

  const sandbox = await sandcastle.createSandbox({
    branch: pr.headRefName,
    baseBranch: base,
    sandbox: noSandbox(),
    hooks: { sandbox: { onSandboxReady: config.setup.map((command) => ({ command })) } },
  });

  try {
    const run = await sandbox.run({
      name: "merge-main",
      maxIterations: 50,
      agent: agent(config),
      promptFile: materialisePrompt("merge-main", config, outputDir()),
      promptArgs: {
        BRANCH: pr.headRefName,
        BASE_BRANCH: base,
        CONFLICTED_FILES: conflicts.map((file) => `- ${file}`).join("\n"),
        COMMIT_PREFIX: config.commitPrefix,
      },
    });

    if (run.commits.length === 0) {
      report("no-commits");
      return;
    }

    // Same loop as the implement workflows, guard included: an agent that can
    // make a merge compile by deleting the tests that disagreed with it is the
    // worst version of that failure, not an exception to it.
    const outcome = await verifyWithRepair(sandbox, run, config);

    switch (outcome.kind) {
      case "checks-passed":
        writeOutput("should_push.txt", "true");
        writeOutput("merge_comment.md", resolutionComment(conflicts, runUrl));
        report("merged", String(conflicts.length));
        break;
      case "checks-failed":
        report("checks-failed", outcome.failedCommand);
        break;
      case "test-guard-tripped":
        report("test-guard-tripped", outcome.detail);
        break;
    }
  } finally {
    await sandbox.close();
  }
}
