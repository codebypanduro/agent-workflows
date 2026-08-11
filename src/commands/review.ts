// Reviews a pull request and says what it thinks. It does not change the code.
//
// Comment-only is enforced by the workflow's permissions, not by the prompt
// asking nicely: the job has no `contents: write`, so a review that tried to
// commit could not push. What it produces is an artifact — a review a human
// can read, and the input implement-pr works from.
//
// Two passes: the reviewer works unconstrained, then a second run resumes its
// session and emits only the JSON. See shared/run-with-extraction.ts.

import * as sandcastle from "@ai-hero/sandcastle";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";
import type { Config } from "../config.ts";
import { loadPrompt, materialisePrompt } from "../prompts.ts";
import { agent, git, outputDir, report, required, writeJson, writeOutput } from "../shared/common.ts";
import { agentLoginFor, fetchPullRequest, renderWork, selectWork } from "../shared/pr-context.ts";
import {
  filterInlineComments,
  parseDiffLines,
  reviewOutputSchema,
  summaryWithDropped,
} from "../shared/review-output.ts";
import { runWithExtraction } from "../shared/run-with-extraction.ts";

export async function review(config: Config): Promise<void> {
  const repo = required("REPO");
  const prNumber = required("PR_NUMBER");
  const agentLogin = agentLoginFor(config, repo);

  const pr = fetchPullRequest(repo, prNumber, config.commitPrefix);
  const diff = git(["diff", `origin/${pr.baseRefName}...HEAD`]);

  console.log(`Reviewing PR #${pr.number}: ${pr.title}\n`);

  const result = await runWithExtraction({
    name: `review-pr-${pr.number}`,
    agent: agent(config),
    sandbox: noSandbox(),
    logging: { type: "stdout" },
    promptFile: materialisePrompt("review", config, outputDir()),
    promptArgs: {
      PR_NUMBER: pr.number,
      PR_TITLE: pr.title,
      BRANCH: pr.headRefName,
      BASE_BRANCH: pr.baseRefName,
      PR_BODY: pr.body,
      // Threads and comments already in flight, so the reviewer does not
      // re-raise something a human has already said.
      EXISTING_FEEDBACK: renderWork(selectWork(pr, agentLogin)) || "_None._",
    },
    output: sandcastle.Output.object({ tag: "output", schema: reviewOutputSchema }),
    extractionPrompt: loadPrompt("review-extraction", config),
  });

  const filtered = filterInlineComments(result.output.inlineComments, parseDiffLines(diff));

  writeJson("review_payload.json", {
    event: "COMMENT",
    body: summaryWithDropped(result.output.summary, filtered.dropped),
    comments: filtered.valid.map((comment) => ({
      path: comment.path,
      line: comment.line,
      side: "RIGHT",
      body: comment.body,
    })),
  });

  writeOutput("review_summary.md", result.output.summary);

  console.log(`\nInline comments: ${filtered.valid.length} valid, ${filtered.dropped.length} dropped.`);
  for (const { comment, reason } of filtered.dropped) {
    console.log(`  dropped ${comment.path}:${comment.line} — ${reason}`);
  }

  report(
    result.output.blocking ? "reviewed-blocking" : "reviewed-clean",
    String(filtered.valid.length),
  );
}
