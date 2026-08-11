# TASK

Address the outstanding review feedback on pull request #{{PR_NUMBER}}: {{PR_TITLE}}

You are on branch `{{BRANCH}}`, which already contains the work. You are not starting over — you are responding to what reviewers said about it.

# THE FEEDBACK

{{FEEDBACK}}

# CONTEXT

Here are the last 10 commits:

<recent-commits>

!`git log -n 10 --format="%H%n%ad%n%B---" --date=short`

</recent-commits>

Read the diff against the base branch before you change anything, so you know what the comments are actually about.

# EXECUTION

Work through the feedback item by item.

- **Fix what is right.** Make the smallest change that genuinely addresses the point.
- **Push back on what is wrong.** You are not obliged to agree. If a comment is mistaken, or asks for something that would make the code worse, leave the code alone and say why in your reply. A reviewer being wrong is a normal outcome, and quietly complying with a bad suggestion is worse than disagreeing with a good one.
- **Do not widen the scope.** Fixing something a reviewer did not mention, however tempting, belongs in its own issue.

No live database is available in this environment — Prisma's client is generated, but nothing is listening. Do not write or run tests that need a real database connection.

# FEEDBACK LOOPS

Before committing, run `npm run typecheck` and `npm run test`.

Never make a failing test pass by deleting it, skipping it, or weakening its assertions. A check runs after you and stops the whole run if the suite shrinks — so that route costs you the attempt and blocks the pull request. If you believe a test is genuinely wrong, leave it failing and say so.

# REPLIES

Write your replies to `{{REPLIES_PATH}}` as a JSON array — nothing else in the file, no prose, no code fence:

```json
[
  { "threadId": "<the thread id from the feedback above>", "body": "Markdown reply" }
]
```

One entry per thread you were given, including the ones you decided not to act on — those are the replies that matter most. Say what you changed, or why you did not. Every thread gets an answer; a thread you skip silently comes back to you on the next run.

# COMMIT

Make one commit per coherent fix. Every commit message must start with the `agent:` prefix and say which feedback it addresses.

Once complete, output <promise>COMPLETE</promise>.
