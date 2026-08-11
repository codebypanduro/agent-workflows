// Maps a run outcome to a label transition, for the workflow to perform.
//
// Reads no config on purpose: it is pure outcome-to-label logic, and it must
// still work on the path where loading the config is what failed.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { emit, outputDir } from "../shared/common.ts";
import { decideTransition, parseOutcome, parseWorkflow } from "../shared/lifecycle.ts";

/**
 * What the run said on its way out.
 *
 * A crash is the one outcome a run cannot report through GITHUB_OUTPUT, so the
 * reason goes to a file instead. Reading it here turns "it crashed" into
 * something a human can act on without opening the log.
 */
function crashReason(): string | undefined {
  const path = join(outputDir(), "failure_reason.txt");
  if (!existsSync(path)) return undefined;
  const text = readFileSync(path, "utf8").trim();
  // Only the first paragraph: a stack trace belongs in the log, not the issue.
  return text === "" ? undefined : text.split("\n\n")[0];
}

export function transition(): void {
  const outcome = process.env.OUTCOME || "crashed";
  const detail = outcome === "crashed" ? (process.env.DETAIL || crashReason()) : process.env.DETAIL;

  const result = decideTransition(
    parseWorkflow(process.env.WORKFLOW ?? ""),
    parseOutcome(outcome, detail),
    {
      runUrl: process.env.RUN_URL ?? "",
      branch: process.env.BRANCH ?? "",
      pullRequestUrl: process.env.PR_URL || undefined,
    },
  );

  emit({
    remove_label: result.removeLabel,
    // Empty means "add nothing here" — the object is going straight back to an
    // agent via the chain, and a terminal label would be wrong on arrival.
    add_label: result.addLabel ?? "",
    chain_label: result.chain?.label ?? "",
    chain_target: result.chain?.target ?? "",
    comment: result.comment?.body ?? "",
  });
}
