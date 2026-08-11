# A personal access token, not `GITHUB_TOKEN`, opens the agent's pull requests — and applies exactly two labels

The agent workflows push branches and open pull requests using a personal access token stored as a repository secret, even though `GITHUB_TOKEN` is available for free and needs no rotation.

A pull request created with `GITHUB_TOKEN` queues its `pull_request` workflow runs in an *approval-required* state: `test.yml` will not run until someone with write access clicks "Approve workflows to run" in the merge box. Since the whole point of handing a pull request to a human is that its checks have already reported, an unattended token is required for the flow to mean anything. GitHub's documented remedy is a personal access token or a GitHub App installation token.

## The second use: chaining

The original version of this decision ended "recursion is not a concern here because the workflow triggers only on the `agent:todo` label, which the workflow itself never applies." That is no longer true, and the change is deliberate.

`GITHUB_TOKEN`'s label events do not trigger workflows. That property was the loop guard — and it is also exactly what stops one workflow handing off to the next. The chain the split needs is:

```
agent:todo (issue) ──PAT──▶ agent:review (PR) ──PAT──▶ agent:todo (PR) ─────▶ human:review
   implement                    review                   implement-pr
```

So two label writes, and only two, use `AGENT_GH_TOKEN`:

1. **implement → `agent:review`** on the pull request it just opened.
2. **review → `agent:todo`** on the pull request it just reviewed, and only when the review is blocking.

Every other label write in every workflow uses `GITHUB_TOKEN` and is inert by construction. It cannot start anything, whatever anyone later adds to the table.

The graph terminates because implement-pr never chains — see [0004](0003-the-agent-chain-is-two-hops-deep.md). Both facts are enforced by tests over the lifecycle table rather than by convention: one asserts the whole table contains exactly two chaining transitions, and one asserts none of them belongs to implement-pr.

## Consequences

A long-lived credential lives in repository secrets and pull requests are authored under a human account rather than a bot identity, which muddies the history slightly. A GitHub App token would fix both and remains the upgrade path if the agent's output volume ever makes authorship confusing.

The loop guard is now a property of the lifecycle table rather than of the token, which is a weaker kind of guarantee — a table with a third chaining edge would compile. It would not pass the tests, and that is where the protection lives.
