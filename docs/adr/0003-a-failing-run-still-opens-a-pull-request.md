# A run whose checks fail still opens a pull request — ready, not draft

After the agent commits, the workflow re-runs typecheck and tests on the branch. If they still fail once every retry is spent, the branch is still pushed and a pull request is still opened — but the issue gets `human:blocked` instead of `human:review`, and the pull request body names the command that failed.

The obvious alternative is to withhold the pull request so that every open agent pull request is known-good. We rejected it because an agent run represents real time and tokens, and a single red test is usually a small fix on top of otherwise sound work; forcing a human to check out the branch and open the pull request by hand to recover it is friction in exactly the case where the work most needs attention. Opening the pull request keeps the work visible and reviewable while the label keeps the board honest about which pull requests are ready.

## Draft or ready

A passing run opens its pull request as a **draft**, because the reviewer is about to look at it and `agent:review` marks it ready when it does. That is a real state: nobody should read it yet.

A failing run opens its pull request **ready**, despite being the one that is *less* finished. A draft pull request carrying `human:blocked` has no route out — no workflow will touch it again, and a draft is precisely the thing a human scrolls past. Ready-with-a-red-X and a `> [!WARNING]` callout naming the failed command is louder, which is the correct volume for the case that needs a person.

The same applies to a run stopped by the test-deletion guard ([0005](0005-the-self-repair-loop-and-its-test-guard.md)), which opens ready with a `> [!CAUTION]` callout instead.

## Consequences

The pull request list contains work that is not ready to merge, so the label on the *issue* — not the existence of a pull request — is the signal that something is worth reading. Draft status is a hint about which agent is next, not a statement about quality.
