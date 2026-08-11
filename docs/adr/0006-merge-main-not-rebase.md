# `agent:merge-main` merges; it never rebases

Bringing a pull request branch up to date is done with `git merge origin/main`, producing a merge commit, and pushed with a plain non-forcing push.

## Why not rebase

Rebasing rewrites the branch's commits, which changes every commit SHA on it. GitHub anchors inline review comments to a commit and a line; when those move, the comments become *outdated* and collapse out of the conversation.

Under the split ([0001](0001-one-label-per-workflow-run.md)) the review workflow has no `contents: write` — inline comments are its entire output, and the input implement-pr works from. A rebase would therefore take a `agent:merge-main` run, which a human asked for to unblock a stale branch, and silently destroy the review that same pipeline just produced.

Everything else follows from that:

- **No force-push.** Nothing rewrites history, so a rejected push means someone else pushed while the run was working. That is reported as `branch-advanced` and this run's commits are dropped — they are reproducible, the other person's may not be.
- **No `--force-with-lease`.** With no history rewriting, plain non-fast-forward rejection is already the race detector.

The cost is merge commits in agent branches. Since pull requests are squashed on merge to `main`, that history is discarded anyway.

## Conflicts

A clean merge never starts an agent — there is nothing to decide, so the run pushes and finishes.

Conflicts are resolved by an agent, and then verified through the same self-repair loop and test guard the implement workflows use ([0005](0005-the-self-repair-loop-and-its-test-guard.md)). Sharing that path is deliberate: an agent that makes a merge compile by deleting the tests that disagreed with it is the *worst* instance of that failure, not an exception to it.

## The mandatory comment

Whenever an agent resolved anything, the run posts a comment naming every conflicted file and the resolution taken.

A wrongly resolved conflict is the highest-consequence silent failure in this pipeline: it can delete working code and still pass every check, because the tests that would have caught it may be on the side that lost. Green tells you nothing here. The comment is the only artifact between "the agent quietly picked one side" and finding out at deploy, and the prompt is explicit that taking one side wholesale requires having read both.

## Consequences

Agent branch history is noisier than a rebased equivalent. Reviewing a pull request after a conflicted merge means reading the merge commit as well as the diff — the comment says so.
