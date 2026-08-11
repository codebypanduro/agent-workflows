# TASK

A merge of `{{BASE_BRANCH}}` into `{{BRANCH}}` is in progress and has stopped on conflicts. Resolve them and commit the merge.

# CONFLICTED FILES

{{CONFLICTED_FILES}}

# WHAT THIS IS

Both sides of every conflict are somebody's work. Your job is to produce the state that keeps **both** intentions, not to pick a winner because picking is easier.

Before you resolve a single hunk, understand what each side was trying to do:

- `git log --oneline HEAD..MERGE_HEAD -- <file>` — what changed on the base branch
- `git log --oneline MERGE_HEAD..HEAD -- <file>` — what this pull request changed
- `git diff --diff-filter=U` — the conflicts themselves

# RULES

1. **Never resolve by taking one side wholesale** unless you have read both and can say why the other is genuinely obsolete. `--ours` and `--theirs` are how working code disappears silently.
2. **A conflict you do not understand is a stopping point, not a coin flip.** If you cannot work out what a hunk was for, say so in your final message and leave the merge unresolved rather than guessing.
3. **Do not use the merge as cover for other changes.** Nothing in this commit should be unrelated to reconciling the two sides.
4. **Delete every conflict marker.** `<<<<<<<`, `=======` and `>>>>>>>` left in a file will compile in some languages and are always a bug.

No live database is available — Prisma's client is generated, but nothing is listening.

# VERIFY

After resolving, run `npm run typecheck` and `npm run test`.

Never make a failing test pass by deleting it, skipping it, or weakening its assertions. That is doubly true here: a test failing after a merge is usually the merge telling you the resolution is wrong. A check runs after you and stops the run if the suite shrinks.

# COMMIT

Commit the merge with `git commit` (the merge state is already staged once conflicts are resolved). The message must start with `agent:` and list, per file, which side you kept and why.

Once complete, output <promise>COMPLETE</promise>.
