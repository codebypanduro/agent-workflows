// Terminal-label decisions for every agent workflow.
//
// One table, four workflows (docs/adr/0001). The failure it guards against is
// an issue or pull request stranded on `agent:in-progress` forever, so every
// outcome — including the ones nobody planned for — maps to a terminal label.
//
// This module knows nothing about GitHub. The workflows call it through
// `transition.mts` and perform the transition with the `gh` CLI.
//
// Refusals are deliberately absent. A refusal happens in a preflight *before*
// the run claims `agent:in-progress`, so it removes the trigger label rather
// than transitioning out of one — a different shape, and not this table's job.

/** Trigger labels — a human or a chaining workflow applies these. */
export const TODO = "agent:todo";
export const REVIEW = "agent:review";
export const MERGE_MAIN = "agent:merge-main";

/** Held for the duration of a run, on the issue or the pull request. */
export const IN_PROGRESS = "agent:in-progress";

/** Terminal labels. `human:` means the next move is a human's (docs/adr/0001). */
export const HUMAN_REVIEW = "human:review";
export const HUMAN_BLOCKED = "human:blocked";

export type Workflow = "implement" | "implement-pr" | "review" | "merge-main";

/** How a run ended. Not every kind is reachable from every workflow. */
export type RunOutcome =
  /** The run died before reporting an outcome — crash, timeout, cancelled job. */
  | { kind: "crashed" }
  /** The agent ran to completion but committed nothing. */
  | { kind: "no-commits" }
  /** Verification failed on the branch, after every retry was spent. */
  | { kind: "checks-failed"; failedCommand: string }
  /** A retry lap went green by removing or skipping tests (docs/adr/0005). */
  | { kind: "test-guard-tripped"; detail: string }
  /** The agent committed, but the branch never reached GitHub. */
  | { kind: "push-failed" }
  /** Someone else pushed to the branch while the run was working on it. */
  | { kind: "branch-advanced" }
  /** The agent committed and verification passed. */
  | { kind: "checks-passed" }
  /** The reviewer found something that needs fixing before a human should look. */
  | { kind: "reviewed-blocking"; commentCount: number }
  /** The reviewer had no blocking findings. */
  | { kind: "reviewed-clean" }
  /** The branch was already up to date with main — nothing merged. */
  | { kind: "already-current" }
  /** main merged in. `conflicts` is 0 for a clean merge, higher when the agent resolved. */
  | { kind: "merged"; conflicts: number };

export type OutcomeKind = RunOutcome["kind"];

export interface TransitionContext {
  /** Link to the Actions run, so a human can read the agent's log. */
  readonly runUrl: string;
  /** The branch the run worked on. */
  readonly branch: string;
  /** The pull request, when there is one. */
  readonly pullRequestUrl?: string;
}

/**
 * A label write that is meant to trigger the next workflow.
 *
 * `GITHUB_TOKEN`'s label events do not trigger workflows, which is what stops
 * the pipeline looping back on itself, so a chaining write must use
 * `AGENT_GH_TOKEN` instead. Exactly two transitions in this table carry one —
 * the two edges of the chain in docs/adr/0002 — and everything else is inert by
 * construction.
 *
 * `target` matters because the chain crosses objects: implement runs on an
 * issue but hands off to the pull request it just opened.
 */
export interface Chain {
  readonly label: typeof TODO | typeof REVIEW;
  readonly target: "self" | "pull-request";
}

export interface LabelTransition {
  readonly removeLabel: typeof IN_PROGRESS;
  /**
   * Applied to the object that triggered the run, with `GITHUB_TOKEN`.
   *
   * `null` only when the run is handing straight to another agent on the same
   * object — a terminal label there would be immediately wrong.
   */
  readonly addLabel: typeof HUMAN_REVIEW | typeof HUMAN_BLOCKED | null;
  readonly chain: Chain | null;
  /** `null` when the outcome speaks for itself and a comment would only repeat it. */
  readonly comment: { readonly template: OutcomeKind; readonly body: string } | null;
}

const salvage = (context: TransitionContext) =>
  context.pullRequestUrl
    ? `The work is open at ${context.pullRequestUrl}.`
    : `The work is on \`${context.branch}\`.`;

const blocked = (
  kind: OutcomeKind,
  body: string,
): LabelTransition => ({
  removeLabel: IN_PROGRESS,
  addLabel: HUMAN_BLOCKED,
  chain: null,
  comment: { template: kind, body },
});

/**
 * Outcomes that mean the same thing whichever workflow produced them.
 *
 * Returns `null` when the workflow needs to interpret the outcome itself.
 */
function shared(
  outcome: RunOutcome,
  context: TransitionContext,
  retryLabel: string,
): LabelTransition | null {
  switch (outcome.kind) {
    case "crashed":
      return blocked(
        "crashed",
        `The agent run did not finish — it crashed, timed out, or was cancelled. Re-apply \`${retryLabel}\` to try again — [run log](${context.runUrl}).`,
      );

    case "checks-failed":
      return blocked(
        "checks-failed",
        `The agent finished, but \`${outcome.failedCommand}\` still failed after every retry. ${salvage(context)} Re-apply \`${retryLabel}\` to try again — [run log](${context.runUrl}).`,
      );

    // Deliberately loud. A retry lap that went green by deleting tests is the
    // one failure mode where the verification chain reports success and is
    // wrong (docs/adr/0005), so it must never read like an ordinary red run.
    case "test-guard-tripped":
      return blocked(
        "test-guard-tripped",
        `**The agent made its tests pass by removing them.** ${outcome.detail}\n\nVerification went green, so nothing downstream would have caught this. The run was stopped instead. ${salvage(context)} Read the diff before re-applying \`${retryLabel}\` — [run log](${context.runUrl}).`,
      );

    // No salvage(): there is nothing to salvage. The runner's worktree goes
    // with the runner, so a run that cannot push has thrown its work away.
    case "push-failed":
      return blocked(
        "push-failed",
        `The agent finished its work, but pushing \`${context.branch}\` was rejected, so the branch never reached GitHub and the work is gone. Fix the push — a token missing the \`workflow\` scope is the usual cause — then re-apply \`${retryLabel}\` to run it again. [Run log](${context.runUrl}).`,
      );

    case "branch-advanced":
      return blocked(
        "branch-advanced",
        `Someone pushed to \`${context.branch}\` while this run was working on it, so the run's commits were dropped rather than overwriting that work. Re-apply \`${retryLabel}\` to run it again against the current branch — [run log](${context.runUrl}).`,
      );

    default:
      return null;
  }
}

function unreachable(workflow: Workflow, outcome: RunOutcome): never {
  throw new Error(`${workflow} cannot produce outcome: ${outcome.kind}`);
}

export function decideTransition(
  workflow: Workflow,
  outcome: RunOutcome,
  context: TransitionContext,
): LabelTransition {
  switch (workflow) {
    case "implement": {
      const common = shared(outcome, context, TODO);
      if (common) return common;

      switch (outcome.kind) {
        // The one place `agent:review` is applied, and therefore one of the two
        // transitions that must trigger the next workflow.
        //
        // The issue lands on human:review rather than being left bare: from
        // here the issue's own work is done and what it is waiting for is a
        // human merging the pull request. The chain continues on the pull
        // request, which is what the reviewer actually reviews.
        case "checks-passed":
          return {
            removeLabel: IN_PROGRESS,
            addLabel: HUMAN_REVIEW,
            chain: { label: REVIEW, target: "pull-request" },
            comment: null,
          };

        case "no-commits":
          return blocked(
            "no-commits",
            `The agent ran but committed nothing, so there is nothing to review. Re-apply \`${TODO}\` to try again — [run log](${context.runUrl}).`,
          );

        default:
          return unreachable(workflow, outcome);
      }
    }

    case "implement-pr": {
      const common = shared(outcome, context, TODO);
      if (common) return common;

      switch (outcome.kind) {
        // Terminates at a human on purpose. Re-requesting review here would
        // close the cycle implement → review → implement (docs/adr/0004); the
        // asymmetry is the only thing bounding the chain.
        case "checks-passed":
          return {
            removeLabel: IN_PROGRESS,
            addLabel: HUMAN_REVIEW,
            chain: null,
            comment: null,
          };

        case "no-commits":
          return blocked(
            "no-commits",
            `The agent read the review feedback but committed nothing. Either it disagreed or it could not find the problem — read the run log and say more on the thread, then re-apply \`${TODO}\`. [Run log](${context.runUrl}).`,
          );

        default:
          return unreachable(workflow, outcome);
      }
    }

    case "review": {
      const common = shared(outcome, context, REVIEW);
      if (common) return common;

      switch (outcome.kind) {
        // The second and last transition that triggers a workflow. One hop
        // only: implement-pr terminates at a human (docs/adr/0004).
        // addLabel is null: the pull request is going straight back to an
        // agent, so any terminal label here would be wrong the moment it
        // landed.
        case "reviewed-blocking":
          return {
            removeLabel: IN_PROGRESS,
            addLabel: null,
            chain: { label: TODO, target: "self" },
            comment: null,
          };

        // The review itself is the comment. Repeating it here would be noise.
        case "reviewed-clean":
          return {
            removeLabel: IN_PROGRESS,
            addLabel: HUMAN_REVIEW,
            chain: null,
            comment: null,
          };

        default:
          return unreachable(workflow, outcome);
      }
    }

    case "merge-main": {
      const common = shared(outcome, context, MERGE_MAIN);
      if (common) return common;

      switch (outcome.kind) {
        // The agent was given conflicts and committed nothing, so the merge is
        // still sitting unresolved in the worktree — which the runner throws
        // away. Nothing was pushed and the branch is untouched.
        case "no-commits":
          return blocked(
            "no-commits",
            `There were merge conflicts, but the agent resolved none of them — most likely it could not work out which side to keep. Merge \`main\` in by hand, or re-apply \`${MERGE_MAIN}\` to try again — [run log](${context.runUrl}).`,
          );

        case "already-current":
          return {
            removeLabel: IN_PROGRESS,
            addLabel: HUMAN_REVIEW,
            chain: null,
            comment: {
              template: "already-current",
              body: `\`${context.branch}\` was already up to date with main — nothing to merge.`,
            },
          };

        // The resolution comment listing every conflicted file is posted by the
        // workflow itself, not from here: it needs the file list, and it must
        // survive a later verification failure that would land on human:blocked.
        case "merged":
          return {
            removeLabel: IN_PROGRESS,
            addLabel: HUMAN_REVIEW,
            chain: null,
            comment:
              outcome.conflicts === 0
                ? {
                    template: "merged",
                    body: `Merged main into \`${context.branch}\` cleanly — no conflicts, checks green.`,
                  }
                : null,
          };

        default:
          return unreachable(workflow, outcome);
      }
    }
  }
}

const WORKFLOWS: readonly Workflow[] = ["implement", "implement-pr", "review", "merge-main"];

export function parseWorkflow(value: string): Workflow {
  const match = WORKFLOWS.find((workflow) => workflow === value);
  if (!match) throw new Error(`Unknown workflow: ${value}`);
  return match;
}

/** Parses an outcome from the strings the workflows pass through the environment. */
export function parseOutcome(kind: string, detail?: string): RunOutcome {
  switch (kind) {
    case "crashed":
    case "no-commits":
    case "push-failed":
    case "branch-advanced":
    case "checks-passed":
    case "reviewed-clean":
    case "already-current":
      return { kind };
    case "checks-failed":
      return { kind, failedCommand: detail ?? "an unnamed command" };
    case "test-guard-tripped":
      return { kind, detail: detail ?? "A retry lap changed the test files." };
    case "reviewed-blocking":
      return { kind, commentCount: Number(detail ?? 0) };
    case "merged":
      return { kind, conflicts: Number(detail ?? 0) };
    default:
      throw new Error(`Unknown run outcome: ${kind}`);
  }
}
