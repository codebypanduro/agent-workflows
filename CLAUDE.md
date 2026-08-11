# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An npm package (`@codebypanduro/agent-workflows`) plus a set of reusable GitHub Actions workflows. Consuming projects run `npx @codebypanduro/agent-workflows init`, which writes four thin caller workflows that point at `codebypanduro/agent-workflows/.github/workflows/*.yml@v1`. All logic lives here; the caller YAML only says *when* to run.

## Commands

```sh
npm run typecheck      # tsc --noEmit — tsconfig.json is noEmit; the source uses .ts import specifiers
npm test               # vitest run
npm run build          # tsc -p tsconfig.build.json → dist/ (also runs on prepare/prepublishOnly)
npx vitest run src/shared/lifecycle.test.ts          # one file
npx vitest run -t "name of the case"                 # one case
```

`.github/workflows/test.yml` runs typecheck, test, build. Keep all three green.

The CLI is exercised as `node dist/cli.js <command>` after a build, or `npx -y github:codebypanduro/agent-workflows#<ref>` from a consuming repo (npm compiles via `prepare`).

## Architecture

**One binary, one command per workflow step.** `src/cli.ts` dispatches to `src/commands/*`. Every step in the reusable YAML is `$CLI <command>`, so the YAML stays a trigger and nothing else. Commands read their inputs from environment variables (`REPO`, `ISSUE_NUMBER`, `PR_NUMBER`, `RUN_URL`, `BRANCH`, …) and report back through `GITHUB_OUTPUT` via `report()`/`emit()` in `src/shared/common.ts`.

**Pure core, thin IO shell.** The branchy decisions are pure and unit tested — `shared/lifecycle.ts` (outcome → label transition), `shared/test-guard.ts`, `shared/pr-context.ts`, `shared/preflight.ts`, `shared/thread-replies.ts`, `shared/review-output.ts`. Anything touching the process, `gh`, or `git` lives in `shared/common.ts`. Keep new decision logic on the pure side and give it a `.test.ts` next to it.

**The lifecycle table is the spine.** `shared/lifecycle.ts` maps `(workflow, RunOutcome)` → `LabelTransition` for all four workflows, and every outcome — including unplanned ones — must reach a terminal label, or an issue/PR is stranded on `agent:in-progress`. Two invariants are asserted by `lifecycle.test.ts` and must not be weakened:

- Exactly **two** transitions carry a `chain` (implement → `agent:review` on the PR; review → `agent:todo` on itself). Only `AGENT_GH_TOKEN` label writes trigger workflows; everything else uses `GITHUB_TOKEN` and is inert by construction.
- `implement-pr` never re-requests review. That asymmetry is the only thing bounding the chain to one automated fix round.

**Verification and the test guard.** `shared/verify.ts` runs `config.verify` in the sandbox; on failure it resumes the *same* agent session with the failing tail (up to `maxRetries`). Between laps `test-guard.ts` counts committed test cases and trips the run if the suite shrank, even when verification went green — the loop otherwise hands a cornered agent `it.skip` as a legal way through a chain that only ends at a comment-only reviewer. The guard is not configurable and must not become configurable.

**Two-pass structured output.** `shared/run-with-extraction.ts`: the producing run works unconstrained, then a second run resumes its session and emits only the schema-tagged JSON. Used by `review`. Note it calls sandcastle's top-level `run()`, not `sandbox.run()` — structured output lives on `RunOptions` only in `@ai-hero/sandcastle` 0.12.

**Prompts.** Markdown in `prompts/`, shipped via `files` in package.json and resolved at `dist/../prompts`. `prompts.ts` appends the project's `prompts.codingStandards` and `prompts.notes` as addenda rather than interpolating, so upstream prompts improve without knowing a project exists, then materialises the result into the run's output dir. `review-extraction` is deliberately not overridable and gets no addenda — it is a format contract coupled to `reviewOutputSchema`.

**Config.** One `agent-workflows.config.json` per consuming repo, zod-validated in `src/config.ts`. `verify` is required with no default on purpose: it must match what the project's PR checks run. Prefer adding a config field or a `prompts.notes` paragraph over a prompt fork.

## Conventions

- ESM, `nodenext`, Node 22+. Imports use explicit `.ts` extensions (`allowImportingTsExtensions` + `rewriteRelativeImportExtensions`); do not write `.js` specifiers.
- `strict` and `noUncheckedIndexedAccess` are on.
- Comments here carry design rationale, not narration — the file headers explain *why* a module exists and what failure it prevents. Match that register when adding modules; don't strip those headers.
- Decisions are recorded in `docs/adr/`. Update or add an ADR when changing the chain, the labels, the guard, or the merge-vs-rebase choice.
- `src/index.ts` is the public surface. Adding an export there is an API commitment.
