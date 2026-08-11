# The agent chain is two hops deep, and implement-pr deliberately does not close the loop

`agent:todo` on an issue produces a pull request and hands it to the reviewer. A blocking review hands it back to an agent. That agent stops.

```
implement(issue) ──▶ review ──▶ implement-pr ──▶ human:review
                                     ╳
                          never re-requests review
```

Every pull request therefore gets exactly one automated fix round before a human sees it.

## Why a bound is needed at all

The chain is built out of label writes made with a token whose events trigger workflows ([0002](0002-the-two-chaining-label-writes.md)). Each hop is legitimate: a real label, applied by the right workflow, for the right reason. Nothing in the trigger conditions distinguishes the second lap from the first. So if implement-pr ended by re-applying `agent:review`, the result would be:

```
implement-pr ──▶ review ──▶ implement-pr ──▶ review ──▶ …
```

running until somebody noticed, at roughly forty minutes and a full agent run per lap. There is no `if:` guard that prevents this, because nothing about any individual hop is wrong.

## Why this bound rather than a counter

The alternatives were a round counter in a hidden marker in the pull request body, or a content-based rule where review refuses to chain if it is repeating itself. Both terminate. Both also introduce state that can desync from reality — a counter someone edits, a marker a squash-merge eats — and every failure mode becomes "why did it stop / why didn't it stop", which is harder to reason about than the thing it was protecting against.

The asymmetry needs no state. The graph is acyclic because it is shaped that way, statically, and you can verify it by reading four cases in one table.

## Consequences

**A second automated round costs a click.** Re-applying `agent:review` after implement-pr finishes gives you another lap. That is a feature — it is the point at which a human decides whether more agent time is worth spending.

**This is load-bearing and looks arbitrary.** "implement-pr should just ask for a re-review, it's obviously better" is the natural next thought for anyone reading the code without this document. It is also how the loop gets closed. The lifecycle tests assert that implement-pr never chains, for every outcome it can produce, so the change fails CI rather than production.

**Adding a fifth workflow means re-checking the graph.** The invariant is not "two labels chain" but "the chain has no cycle". The test asserting exactly two chaining transitions is a proxy that will need rethinking, not just updating, if the topology changes.
