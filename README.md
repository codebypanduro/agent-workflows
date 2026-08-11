# agent-workflows

Label-driven coding-agent workflows for GitHub Actions. Label an issue, get a reviewed pull request.

```
agent:todo (issue) ──▶ agent:review (PR) ──▶ agent:todo (PR) ──▶ human:review
   implement              review               implement-pr
   draft PR            comments only          fixes + replies
```

Every pull request gets **one** automated fix round, then stops and waits for you.

## Install

```sh
cd your-project
npx @codebypanduro/agent-workflows init
```

That writes four caller workflows and a config file, creates the six labels, and tells you which secrets are missing. Then:

```sh
gh secret set AGENT_GH_TOKEN           # PAT: contents, issues, pull requests, workflow
gh secret set CLAUDE_CODE_OAUTH_TOKEN  # from `claude setup-token`
```

Commit, push, label an issue `agent:todo`.

## Configure

Everything project-specific lives in `agent-workflows.config.json`:

```json
{
  "verify": ["npm run typecheck", "npm run test"],
  "setup": ["npm ci", "cd packages/db && npx prisma generate"],
  "env": { "DATABASE_URL": "postgresql://dummy:dummy@localhost:5432/dummy" },
  "git": { "name": "acme agent", "email": "dev@acme.com" },
  "prompts": {
    "codingStandards": "CONTRIBUTING.md",
    "notes": "No live database is available in CI. Never edit anything under generated/."
  }
}
```

`verify` is the only required field, and it has no default on purpose: it must be the same commands your PR checks run. If an agent can pass something CI would fail, none of the rest of this means anything.

`prompts.notes` is the escape hatch you want before you reach for `prompts.implement`. A forked prompt stops receiving improvements; a paragraph of project context composes with them.

## The labels

You apply these:

| Label | On | Means |
| --- | --- | --- |
| `agent:todo` | issue | Implement this from scratch. |
| `agent:todo` | pull request | Address the outstanding review feedback. |
| `agent:review` | pull request | Review this. |
| `agent:merge-main` | pull request | Bring the base branch in. |

The workflows apply these — exactly one at a time, and the prefix says whose move it is:

| Label | Means |
| --- | --- |
| `agent:in-progress` | A run is working this right now. |
| `human:review` | Done. Over to you. |
| `human:blocked` | Ended without usable output. Needs your decision. |

## Three things worth knowing before you rely on it

**The reviewer cannot write code.** Its job has no `contents: write`, so "comment-only" is a fact rather than a promise. Its findings become the input the fix round works from — an artifact you can read and disagree with, rather than a silent rewrite.

**The chain is bounded structurally.** Exactly two label writes use the PAT (the only token whose label events trigger workflows), and the fix round never re-requests review. Both are asserted by tests over the lifecycle table, so closing the loop fails CI rather than costing you a runaway spend.

**A failing run retries, and the retry is guarded.** The agent's session is resumed with the failure, up to three attempts. That hands a cornered agent one move that always works — `it.skip`, delete the assertion, drop the file — which would pass verification, pass your CI, and reach a reviewer that only comments. So the test suite is counted between laps, and a lap that went green by shrinking it stops the run regardless. Adding tests, rewriting a case, or renaming a file are all fine.

## What it will not do

Merge anything. Push to your default branch. Close an issue. Rebase a branch (that would detach the review comments). Resolve a review thread on your behalf — it replies instead, and the reply is what stops the next run re-fixing the same feedback.

## Requirements

- Node 22+
- `gh` available in the workflow (it is, on `ubuntu-latest`)
- A Claude Code OAuth token and a PAT
- Your repo's CI green on `main` — the agent's pass criterion is your verify commands

## On a public repository

The three pull-request workflows use `pull_request_target`, which runs with the repository's secrets and checks out the head branch. Unguarded, that means a fork's code executes with your tokens the moment any collaborator applies a label.

`init` therefore generates every pull-request caller with a same-repo condition:

```yaml
    if: >-
      github.event.label.name == 'agent:review'
      && github.event.pull_request.head.repo.full_name == github.repository
```

Fork pull requests simply do not trigger them. On a private repository this costs nothing; on a public one it is the difference between a convenience and a credential leak. Do not remove it to "make it work for contributors" — that is precisely the case it exists for.

## Troubleshooting

**"Invalid workflow file … the nested job is requesting … but is only allowed …"**

The caller is not granting the permissions the called workflow needs. A reusable workflow can only *narrow* what its caller has, never widen it, and most repositories default `GITHUB_TOKEN` to read-only — which is the right setting to keep.

`init` writes the correct `permissions:` block into each caller. If you hand-wrote them, or generated them with an older version, re-run `init`.

**"Startup failure" with no log at all**

Same class of problem. A run that dies during workflow validation never reaches a step, so there is nothing to log — read the annotation on the run's summary page rather than looking for job output.

**Every run fails at once**

Usually an expired `CLAUDE_CODE_OAUTH_TOKEN`. Regenerate with `claude setup-token`.

## Pinning

The caller workflows `init` writes point at `@v1` and run `npx @codebypanduro/agent-workflows@latest`. To pin the runtime, pass `package-version`:

```yaml
    uses: codebypanduro/agent-workflows/.github/workflows/implement.yml@v1
    with:
      package-version: "1.2.3"
    secrets: inherit
```

Re-running `init` refreshes the caller workflows and leaves your config alone.

## Licence

MIT.
