# The self-repair loop, and the guard without which it is net-negative

When verification fails, the agent's session is resumed with the failing output appended and it tries again — twice, three attempts in total. Between every lap, the test files on the branch are counted. **If a lap removed or disabled test cases, the run is stopped even though verification went green.**

The second half is not a refinement of the first. It is the condition on which the first is worth having.

## The loop

Retrying by resuming the session rather than starting fresh is what makes it cheap: the agent still has the codebase in context and can see what it already tried, so lap two is minutes rather than a re-read of the repository. `SandboxRunResult.resume()` in `@ai-hero/sandcastle` does exactly this.

Three attempts, because past that the agent is not converging and the run is better spent telling a human.

## The guard

Consider what the loop actually says to a failing agent: *make the red go away*. Say it three times.

An agent that genuinely cannot fix the bug is looking at one move that always works — `it.skip`, deleting the assertion, dropping the file. That move passes verification. It passes `test.yml` on the pull request, because `test.yml` runs the same suite that just shrank. And it reaches a reviewer that, by design ([0001](0001-one-label-per-workflow-run.md)), only comments.

So the loop hands the agent a legal path that defeats the entire verification chain, and the chain reports success. Without the guard, the honest description of this feature is "up to three chances to quietly delete the failing test", and it would be better not to ship it.

## How it counts

Counting test cases per file, not diffing text. The agent is *supposed* to edit tests while fixing things, and a guard that fires on every legitimate edit is a guard someone turns off.

- Removing a file, removing cases from a file, or adding `.skip` / `.todo` / `.failing` — **trips**.
- Adding cases, rewriting a case in place, or renaming a file that keeps its cases — **allowed**.
- Comments are stripped before counting, so `// call it(name, fn)` is not a test and deleting that line is not a deletion.

It is a regex over committed file contents. It can be fooled — by a case that is `return`ed out of, by generated tests, by a rename that also legitimately drops a case. It is not a proof; it is a tripwire on the one move an agent under pressure actually reaches for.

The run reports `test-guard-tripped`, which is deliberately a *different* outcome from `checks-failed` and gets a louder comment. "Your tests failed" and "your tests passed because they are gone" are not the same message.

## Consequences

**Some legitimate work gets blocked.** Deleting a genuinely obsolete test during a fix trips this, and a human has to unblock it. That is the correct trade at this ratio.

**The guard only runs between retry laps.** An agent that deletes tests on its *first* attempt and goes green is not caught — there is no earlier census to compare against. The first attempt is not under the same pressure, and `test.yml` plus a human reviewing the diff remain the backstop there. Widening this to compare against the base branch is the obvious extension and has not been needed yet.

**This will look like paranoia to whoever reads it next.** The loop works fine in the common case and the guard never fires, which is exactly what makes it a candidate for deletion during a cleanup. It has its own unit tests naming each move it catches, and this document exists so the reason survives.
