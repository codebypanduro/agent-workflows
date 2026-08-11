import { describe, expect, it } from "vitest";
import {
  decideTransition,
  parseOutcome,
  parseWorkflow,
  HUMAN_BLOCKED,
  HUMAN_REVIEW,
  IN_PROGRESS,
  REVIEW,
  TODO,
  type RunOutcome,
  type TransitionContext,
  type Workflow,
} from "./lifecycle.ts";

const context: TransitionContext = {
  runUrl: "https://github.com/codebypanduro/tvoverblik/actions/runs/1",
  branch: "agent/issue-42",
};

/** Every outcome each workflow can actually produce. */
const REACHABLE: Record<Workflow, RunOutcome[]> = {
  implement: [
    { kind: "crashed" },
    { kind: "no-commits" },
    { kind: "checks-failed", failedCommand: "npm run test" },
    { kind: "test-guard-tripped", detail: "`a.test.ts` lost 2 test case(s)." },
    { kind: "push-failed" },
    { kind: "checks-passed" },
  ],
  "implement-pr": [
    { kind: "crashed" },
    { kind: "no-commits" },
    { kind: "checks-failed", failedCommand: "npm run test" },
    { kind: "test-guard-tripped", detail: "`a.test.ts` was deleted." },
    { kind: "push-failed" },
    { kind: "branch-advanced" },
    { kind: "checks-passed" },
  ],
  review: [
    { kind: "crashed" },
    { kind: "reviewed-blocking", commentCount: 3 },
    { kind: "reviewed-clean" },
  ],
  "merge-main": [
    { kind: "crashed" },
    { kind: "no-commits" },
    { kind: "checks-failed", failedCommand: "npm run typecheck" },
    { kind: "test-guard-tripped", detail: "`a.test.ts` had 1 test case(s) skipped." },
    { kind: "branch-advanced" },
    { kind: "already-current" },
    { kind: "merged", conflicts: 0 },
    { kind: "merged", conflicts: 3 },
  ],
};

const WORKFLOWS = Object.keys(REACHABLE) as Workflow[];

describe("the invariants that keep the board honest", () => {
  it("always transitions out of agent:in-progress", () => {
    for (const workflow of WORKFLOWS) {
      for (const outcome of REACHABLE[workflow]) {
        expect(decideTransition(workflow, outcome, context).removeLabel).toBe(IN_PROGRESS);
      }
    }
  });

  it("never leaves an object with neither a label nor a chain", () => {
    for (const workflow of WORKFLOWS) {
      for (const outcome of REACHABLE[workflow]) {
        const transition = decideTransition(workflow, outcome, context);
        expect(transition.addLabel ?? transition.chain).not.toBeNull();
      }
    }
  });

  // This is the loop bound. Two chaining edges, statically: implement hands to
  // review, review hands to implement-pr, implement-pr hands to a human
  // (docs/adr/0004). A third edge anywhere here closes the cycle.
  it("has exactly two chaining transitions in the whole table", () => {
    const chaining = WORKFLOWS.flatMap((workflow) =>
      REACHABLE[workflow]
        .map((outcome) => ({ workflow, chain: decideTransition(workflow, outcome, context).chain }))
        .filter((entry) => entry.chain !== null),
    );

    expect(chaining).toEqual([
      { workflow: "implement", chain: { label: REVIEW, target: "pull-request" } },
      { workflow: "review", chain: { label: TODO, target: "self" } },
    ]);
  });

  it("never chains from implement-pr, whatever happened", () => {
    for (const outcome of REACHABLE["implement-pr"]) {
      expect(decideTransition("implement-pr", outcome, context).chain).toBeNull();
    }
  });

  it("explains itself whenever it blocks", () => {
    for (const workflow of WORKFLOWS) {
      for (const outcome of REACHABLE[workflow]) {
        const transition = decideTransition(workflow, outcome, context);
        if (transition.addLabel === HUMAN_BLOCKED) {
          expect(transition.comment?.body).toBeTruthy();
        }
      }
    }
  });

  it("refuses an outcome a workflow cannot produce", () => {
    expect(() => decideTransition("review", { kind: "checks-passed" }, context)).toThrow(
      /review cannot produce outcome: checks-passed/,
    );
  });
});

describe("implement", () => {
  it("chains a passing run to the reviewer, on the pull request", () => {
    const transition = decideTransition("implement", { kind: "checks-passed" }, context);

    // The issue itself lands on human:review — its work is done and what it
    // waits for now is a human merging.
    expect(transition.addLabel).toBe(HUMAN_REVIEW);
    expect(transition.chain).toEqual({ label: REVIEW, target: "pull-request" });
    expect(transition.comment).toBeNull();
  });

  it("blocks a red run rather than sending broken code to a reviewer", () => {
    const transition = decideTransition(
      "implement",
      { kind: "checks-failed", failedCommand: "npm run typecheck" },
      context,
    );

    expect(transition.addLabel).toBe(HUMAN_BLOCKED);
    expect(transition.chain).toBeNull();
    expect(transition.comment?.body).toContain("npm run typecheck");
  });

  it("says the work is gone when the push was rejected, and does not offer to salvage it", () => {
    const transition = decideTransition("implement", { kind: "push-failed" }, {
      ...context,
      pullRequestUrl: "https://github.com/x/y/pull/1",
    });

    expect(transition.comment?.body).toContain("the work is gone");
    expect(transition.comment?.body).not.toContain("The work is open at");
  });

  it("names the guard explicitly, so a green suite is not mistaken for success", () => {
    const transition = decideTransition(
      "implement",
      { kind: "test-guard-tripped", detail: "`a.test.ts` lost 2 test case(s)." },
      context,
    );

    expect(transition.addLabel).toBe(HUMAN_BLOCKED);
    expect(transition.comment?.body).toContain("made its tests pass by removing them");
    expect(transition.comment?.body).toContain("`a.test.ts` lost 2 test case(s).");
  });
});

describe("review", () => {
  it("hands a blocking review back to an agent, with no terminal label", () => {
    const transition = decideTransition(
      "review",
      { kind: "reviewed-blocking", commentCount: 2 },
      context,
    );

    expect(transition.addLabel).toBeNull();
    expect(transition.chain).toEqual({ label: TODO, target: "self" });
  });

  it("hands a clean review to a human without commentary", () => {
    const transition = decideTransition("review", { kind: "reviewed-clean" }, context);

    expect(transition.addLabel).toBe(HUMAN_REVIEW);
    expect(transition.chain).toBeNull();
    expect(transition.comment).toBeNull();
  });
});

describe("merge-main", () => {
  it("comments on a clean merge but stays quiet about a resolved one", () => {
    // The resolved case gets its comment from the workflow instead, because
    // that one needs the file list.
    expect(decideTransition("merge-main", { kind: "merged", conflicts: 0 }, context).comment)
      .not.toBeNull();
    expect(decideTransition("merge-main", { kind: "merged", conflicts: 3 }, context).comment)
      .toBeNull();
  });

  it("tells a human when there was nothing to merge", () => {
    const transition = decideTransition("merge-main", { kind: "already-current" }, context);

    expect(transition.addLabel).toBe(HUMAN_REVIEW);
    expect(transition.comment?.template).toBe("already-current");
  });

  it("keeps this run's commits rather than overwriting someone else's", () => {
    const transition = decideTransition("merge-main", { kind: "branch-advanced" }, context);

    expect(transition.addLabel).toBe(HUMAN_BLOCKED);
    expect(transition.comment?.body).toContain("agent:merge-main");
  });
});

describe("parseOutcome", () => {
  it("round-trips every kind the workflows emit", () => {
    expect(parseOutcome("checks-passed")).toEqual({ kind: "checks-passed" });
    expect(parseOutcome("checks-failed", "npm run test")).toEqual({
      kind: "checks-failed",
      failedCommand: "npm run test",
    });
    expect(parseOutcome("merged", "3")).toEqual({ kind: "merged", conflicts: 3 });
    expect(parseOutcome("reviewed-blocking", "2")).toEqual({
      kind: "reviewed-blocking",
      commentCount: 2,
    });
  });

  it("still produces a usable outcome when the detail is missing", () => {
    expect(parseOutcome("checks-failed")).toEqual({
      kind: "checks-failed",
      failedCommand: "an unnamed command",
    });
    expect(parseOutcome("merged")).toEqual({ kind: "merged", conflicts: 0 });
  });

  it("throws on anything it does not recognise", () => {
    expect(() => parseOutcome("nonsense")).toThrow(/Unknown run outcome/);
    expect(() => parseWorkflow("nonsense")).toThrow(/Unknown workflow/);
  });
});
