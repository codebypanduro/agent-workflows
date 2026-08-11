// Implements one issue on a fresh branch.
//
// Leaves a branch behind for the workflow to turn into a draft pull request,
// and reports how the run ended via GITHUB_OUTPUT. Anything this cannot report
// — a crash, a timeout, a cancelled job — the workflow's failure handler picks
// up as `crashed`.

import * as sandcastle from "@ai-hero/sandcastle";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";
import { branchFor, type Config } from "../config.ts";
import { materialisePrompt } from "../prompts.ts";
import { agent, configureGitIdentity, outputDir, report, required } from "../shared/common.ts";
import { verifyWithRepair } from "../shared/verify.ts";

export async function implement(config: Config): Promise<void> {
  const issueNumber = required("ISSUE_NUMBER");
  const issueTitle = required("ISSUE_TITLE");
  const branch = branchFor(config, issueNumber);
  const baseBranch = process.env.BASE_BRANCH ?? "main";

  configureGitIdentity(config);

  console.log(`Working issue #${issueNumber}: ${issueTitle}`);
  console.log(`Branch ${branch}, forked from ${baseBranch}\n`);

  const sandbox = await sandcastle.createSandbox({
    branch,
    baseBranch,
    sandbox: noSandbox(),
    // The worktree is a clean checkout, so whatever the tests need to exist has
    // to be built here first.
    hooks: { sandbox: { onSandboxReady: config.setup.map((command) => ({ command })) } },
  });

  try {
    const run = await sandbox.run({
      name: "implementer",
      maxIterations: 100,
      agent: agent(config),
      promptFile: materialisePrompt("implement", config, outputDir()),
      promptArgs: {
        TASK_ID: issueNumber,
        ISSUE_TITLE: issueTitle,
        BRANCH: branch,
        COMMIT_PREFIX: config.commitPrefix,
      },
    });

    if (run.commits.length === 0) {
      // Nothing to push, nothing to verify, nothing to review.
      report("no-commits");
      return;
    }

    console.log(`\nImplementer made ${run.commits.length} commit(s). Verifying.\n`);

    // No reviewer here: review is its own workflow, on the pull request, where
    // its comments are an artifact a human can read.
    const outcome = await verifyWithRepair(sandbox, run, config);

    switch (outcome.kind) {
      case "checks-passed":
        report("checks-passed");
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
