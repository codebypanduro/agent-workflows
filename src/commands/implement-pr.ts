// Addresses review feedback on an existing pull request.
//
// Same verb as implement — make the code satisfy what was asked — but the ask
// comes from the review threads rather than an issue body. It terminates at a
// human and never re-requests review; that asymmetry is what bounds the chain.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as sandcastle from "@ai-hero/sandcastle";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";
import type { Config } from "../config.ts";
import { materialisePrompt } from "../prompts.ts";
import { agent, configureGitIdentity, outputDir, report, required, writeJson } from "../shared/common.ts";
import { agentLoginFor, fetchPullRequest, renderWork, selectWork } from "../shared/pr-context.ts";
import { parseAgentReplies, planReplies, type AgentReply } from "../shared/thread-replies.ts";
import { verifyWithRepair } from "../shared/verify.ts";

/** Where the prompt tells the agent to put its thread replies. */
const REPLIES_FILE = "agent_replies.json";

function readAgentReplies(): AgentReply[] {
  try {
    return parseAgentReplies(readFileSync(join(outputDir(), REPLIES_FILE), "utf8"));
  } catch {
    // Absent or unparseable. Every thread falls back to a templated reply,
    // which still marks it answered — not worth failing the run over.
    return [];
  }
}

export async function implementPr(config: Config): Promise<void> {
  const repo = required("REPO");
  const prNumber = required("PR_NUMBER");
  const runUrl = required("RUN_URL");
  const agentLogin = agentLoginFor(config, repo);

  const pr = fetchPullRequest(repo, prNumber, config.commitPrefix);
  const work = selectWork(pr, agentLogin);

  configureGitIdentity(config);

  console.log(`Working PR #${pr.number}: ${pr.title}`);
  console.log(`${work.threads.length} thread(s), ${work.comments.length} comment(s)\n`);

  const sandbox = await sandcastle.createSandbox({
    branch: pr.headRefName,
    baseBranch: pr.baseRefName,
    sandbox: noSandbox(),
    hooks: { sandbox: { onSandboxReady: config.setup.map((command) => ({ command })) } },
  });

  try {
    const run = await sandbox.run({
      name: "implement-pr",
      maxIterations: 100,
      agent: agent(config),
      promptFile: materialisePrompt("implement-pr", config, outputDir()),
      promptArgs: {
        PR_NUMBER: pr.number,
        PR_TITLE: pr.title,
        BRANCH: pr.headRefName,
        FEEDBACK: renderWork(work),
        REPLIES_PATH: join(outputDir(), REPLIES_FILE),
        COMMIT_PREFIX: config.commitPrefix,
      },
    });

    // Every selected thread gets a reply whether or not the agent wrote one for
    // it: a thread the agent silently skipped would otherwise come back as
    // unanswered work on the next run, forever.
    writeJson("thread_replies.json", planReplies(work.threads, readAgentReplies(), runUrl));

    if (run.commits.length === 0) {
      report("no-commits");
      return;
    }

    console.log(`\nMade ${run.commits.length} commit(s). Verifying.\n`);

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
