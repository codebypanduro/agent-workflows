// Reasons to refuse a run before it costs anything.
//
// A refusal is not a failure: nothing was claimed, nothing was lost, and the
// trigger label comes back off so the board does not show work in flight that
// is not. These run before the claim step, which is why they are not part of
// the lifecycle table — there is no `agent:in-progress` to transition out of.
//
// Pure. The CLIs that call this do the `gh` work.

export interface Refusal {
  readonly reason: string;
}

export interface ImplementPreconditions {
  /** Whether `agent/issue-N` already exists on the remote. */
  readonly branchExists: boolean;
  /** An open pull request that already closes this issue, if any. */
  readonly existingPullRequestUrl?: string;
}

/**
 * Refuses a from-scratch implement run when there is already work for the issue.
 *
 * Both branches of this exist because the alternative is two pull requests
 * racing to close one issue. The correct verb in that situation is
 * "address the feedback on the existing pull request", which is a different
 * label on a different object.
 */
export function refuseImplement(
  issueNumber: string,
  branch: string,
  pre: ImplementPreconditions,
): Refusal | null {
  if (pre.existingPullRequestUrl) {
    return {
      reason: `${pre.existingPullRequestUrl} is already open for this issue. Label that pull request \`agent:todo\` to keep working on it, or close it first.`,
    };
  }

  if (pre.branchExists) {
    return {
      reason: `\`${branch}\` already exists on the remote, so this run would collide with work that is already there. Delete the branch if it is dead, or open a pull request from it and label that instead.`,
    };
  }

  return null;
}

export interface ImplementPrPreconditions {
  readonly isOpen: boolean;
  readonly threadCount: number;
  readonly commentCount: number;
}

/**
 * Refuses a feedback run with nothing to act on.
 *
 * The empty case is the common one: the label gets applied to a pull request
 * that has no outstanding review threads, and without this the agent would run
 * against no instructions and do something arbitrary for forty minutes.
 */
export function refuseImplementPr(pre: ImplementPrPreconditions): Refusal | null {
  if (!pre.isOpen) {
    return { reason: "This pull request is not open." };
  }

  if (pre.threadCount === 0 && pre.commentCount === 0) {
    return {
      reason:
        "There are no unresolved review threads and no new comments since the last agent commit, so there is nothing to address. Leave a comment saying what you want changed, then re-apply `agent:todo`.",
    };
  }

  return null;
}
