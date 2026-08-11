import { describe, expect, it } from "vitest";
import { refuseImplement, refuseImplementPr } from "./preflight.ts";

describe("refuseImplement", () => {
  it("starts a run when the issue has no work in flight", () => {
    expect(refuseImplement("42", "agent/issue-42", { branchExists: false })).toBeNull();
  });

  // Otherwise two pull requests race to close one issue.
  it("refuses when a pull request already closes the issue, and names it", () => {
    const refusal = refuseImplement("42", "agent/issue-42", {
      branchExists: true,
      existingPullRequestUrl: "https://github.com/x/y/pull/9",
    });

    expect(refusal?.reason).toContain("https://github.com/x/y/pull/9");
    expect(refusal?.reason).toContain("agent:todo");
  });

  it("refuses a bare leftover branch and says how to clear it", () => {
    const refusal = refuseImplement("42", "agent/issue-42", { branchExists: true });

    expect(refusal?.reason).toContain("agent/issue-42");
    expect(refusal?.reason).toContain("Delete the branch");
  });

  it("prefers the pull request explanation over the branch one", () => {
    const refusal = refuseImplement("42", "agent/issue-42", {
      branchExists: true,
      existingPullRequestUrl: "https://github.com/x/y/pull/9",
    });

    expect(refusal?.reason).not.toContain("Delete the branch");
  });
});

describe("refuseImplementPr", () => {
  it("runs when there is a thread to address", () => {
    expect(refuseImplementPr({ isOpen: true, threadCount: 1, commentCount: 0 })).toBeNull();
  });

  it("runs when there is only a top-level instruction", () => {
    expect(refuseImplementPr({ isOpen: true, threadCount: 0, commentCount: 1 })).toBeNull();
  });

  // The expensive mistake: an agent running for 40 minutes against no
  // instructions because someone mislabelled a pull request.
  it("refuses with nothing to act on", () => {
    const refusal = refuseImplementPr({ isOpen: true, threadCount: 0, commentCount: 0 });

    expect(refusal?.reason).toContain("nothing to address");
  });

  it("refuses a closed pull request even when it has threads", () => {
    expect(refuseImplementPr({ isOpen: false, threadCount: 3, commentCount: 2 })?.reason).toContain(
      "not open",
    );
  });
});
