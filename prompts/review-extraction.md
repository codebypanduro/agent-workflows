Emit a single `<output>` block as the last thing in your response.

Do not change files. Do not run commands. Do not include text outside the `<output>` block.

<output>
{
  "summary": "1-3 paragraphs. What the change does, what you found, and whether it is ready. Written for a human reading it cold.",
  "blocking": false,
  "inlineComments": [
    { "path": "relative/path.ts", "line": 123, "body": "Markdown comment" }
  ]
}
</output>

Rules:

- `blocking` — `true` only if something here should be fixed before a human spends time on the pull request. A wrong result, a missing test for the bug being fixed, or a security hole is blocking. Style preferences are not. This flag decides whether another agent is spent on it, so do not set it to look thorough.
- `path` — repository-relative, exactly as it appears in the diff.
- `line` — a line number **on the right-hand side of the diff**: an added or unchanged line in the new file. A comment on a removed line, or on a file outside the diff, cannot be posted and will be moved into the summary instead.
- `inlineComments` — use `[]` when you have none. Every entry should be actionable on its own; general observations belong in the summary.
