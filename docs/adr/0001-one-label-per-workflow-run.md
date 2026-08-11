# One label per workflow run; the planner and merger are local-only

Supersedes the original "one issue per workflow run". The reasoning below is unchanged in substance — the unit of work simply stopped being an issue.

Each agent workflow triggers on exactly one label, does one job, and owns the lifecycle state of the object that label was applied to. There are four:

| Workflow | Trigger object | Label | Does |
| --- | --- | --- | --- |
| implement | issue | `agent:todo` | writes the code, opens a draft pull request |
| implement-pr | pull request | `agent:todo` | addresses the review feedback |
| review | pull request | `agent:review` | posts a review; changes nothing |
| merge-main | pull request | `agent:merge-main` | brings the branch up to date |

the local batch loop (`main.mts` in a consuming repo) still runs a four-phase batch loop locally — plan, implement, review, merge to the current branch — driven by a planner agent that builds a dependency graph across the whole backlog. The GitHub Actions pipeline deliberately does **not** use that loop.

We chose this because lifecycle labels only make sense per-object: a batch run has no honest way to say which issue is `agent:in-progress`, and a single failure inside the batch poisons unrelated work. One label per run makes the label state a fact about the run, gives each run its own readable Actions log and its own concurrency group, and replaces the merger with a pull request that a human approves.

## Why the split, rather than one workflow with phases

The original design ran the implementer and reviewer inside a single run, in one sandbox, on one branch. Splitting them buys three things:

**The review becomes an artifact.** A reviewer running inside the implement job could only express itself by editing code, which meant its judgement vanished into a diff nobody attributes to it. As a separate workflow with no `contents: write`, it can only produce a review — something a human reads and disagrees with.

**Each phase is retriable on its own.** A reviewer that crashed used to take the implementer's work with it. Now `agent:review` can be re-applied without re-implementing anything.

**A pull request becomes a first-class input.** Work that arrives as feedback on an existing branch has the same shape as work that arrives as an issue, and now goes through the same verb.

## Consequences

We lose the planner's cross-issue dependency reasoning. Two issues labelled at the same time both branch from `main` and can produce conflicting pull requests; the human reviewing them is the conflict resolution mechanism, and `agent:merge-main` exists to pull `main` back in afterwards. The planner remains available locally via the consuming project's own batch script.

Four workflows share one lifecycle table (`src/shared/lifecycle.ts`) rather than one each. That is deliberate: the invariant worth protecting is *no object is ever stranded on `agent:in-progress`*, and it is only checkable if every transition lives in one place. The tests assert it across all four.
