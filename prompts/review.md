# TASK

Review pull request #{{PR_NUMBER}} — {{PR_TITLE}} — on branch `{{BRANCH}}`, against `{{BASE_BRANCH}}`.

**You are reviewing, not fixing.** Do not edit any file, do not commit, do not push. This run has no write access to the repository, so an attempt to change code fails the run rather than helping. Your entire output is the review.

That constraint is the point: a review a human can read is worth more than a silent rewrite they cannot audit. Anything you would have fixed, describe precisely enough that the next agent can fix it from your words alone.

# PULL REQUEST BODY

{{PR_BODY}}

# FEEDBACK ALREADY ON THIS PULL REQUEST

{{EXISTING_FEEDBACK}}

Do not re-raise any of it. A human has already said it, and repeating it back is noise.

# CONTEXT

## Diff against the base branch

!`git diff origin/{{BASE_BRANCH}}...HEAD`

## Commits on this branch

!`git log origin/{{BASE_BRANCH}}..HEAD --oneline`

# WHAT TO LOOK FOR

Read the diff properly before forming an opinion. A review that could have been written from the pull request title is worthless.

1. **Correctness.** Does the implementation do what the issue asked? Which edge cases are unhandled? Are there unsafe casts, `any` types, or unchecked assumptions? For each one, say what input produces what wrong result — a correctness claim you cannot demonstrate is a guess, and should be phrased as one or dropped.

2. **Test coverage.** Is the new behaviour actually covered? A test that asserts the implementation's own output back at it is not coverage. Check especially that tests were added for the bug being fixed, not just for the happy path.

3. **Security.** Injection, leaked credentials, unvalidated input crossing a trust boundary, secrets in logs.

4. **Clarity and consistency.** Unnecessary complexity, redundant abstractions, names that mislead, nested ternaries, comments restating the code. Follow @.sandcastle/CODING_STANDARDS.md.

5. **Scope.** Did the change touch things the issue did not ask about?

# CALIBRATION

Rank what you find. Three real problems stated plainly beat fifteen observations, and a reviewer who flags everything trains everyone to skip the review.

Decide honestly whether the pull request is **blocking**: is there something here that should be fixed before a human spends time on it? Style preferences and nice-to-haves are not blocking. A wrong result, a missing test for the actual bug, or a security hole is. If the change is fine, say so and do not manufacture findings to look thorough.

Once you have finished reviewing, output <promise>COMPLETE</promise>.
