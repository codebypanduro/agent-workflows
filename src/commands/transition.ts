// Maps a run outcome to a label transition, for the workflow to perform.
//
// Reads no config on purpose: it is pure outcome-to-label logic, and it must
// still work on the path where loading the config is what failed.

import { emit } from "../shared/common.ts";
import { decideTransition, parseOutcome, parseWorkflow } from "../shared/lifecycle.ts";

export function transition(): void {
  const result = decideTransition(
    parseWorkflow(process.env.WORKFLOW ?? ""),
    parseOutcome(process.env.OUTCOME ?? "crashed", process.env.DETAIL),
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
