// One-time setup for a project that wants these workflows.
//
// Writes four caller workflows and a config file, creates the six labels, and
// tells you what is still missing. Everything it does is idempotent: re-running
// after an upgrade refreshes the caller workflows and leaves your config alone.
//
// It deliberately does not create secrets. A CLI that offers to store a
// long-lived token for you is a CLI that has to be trusted with one.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_FILENAME, type ConfigInput } from "../config.ts";
import { gh, tryGh } from "../shared/common.ts";
import {
  HUMAN_BLOCKED,
  HUMAN_REVIEW,
  IN_PROGRESS,
  MERGE_MAIN,
  REVIEW,
  TODO,
} from "../shared/lifecycle.ts";

/** Pinned so an upgrade to the package is a deliberate act, not a surprise. */
export const WORKFLOW_REF = "v1";

const OWNER = "codebypanduro/agent-workflows";

interface LabelSpec {
  readonly name: string;
  readonly color: string;
  readonly description: string;
}

export const LABELS: readonly LabelSpec[] = [
  { name: TODO, color: "1D76DB", description: "On an issue: implement it. On a pull request: address the review feedback." },
  { name: REVIEW, color: "0E8A16", description: "A pull request waiting for an agent review" },
  { name: MERGE_MAIN, color: "0E8A16", description: "A pull request that wants its base branch merged in" },
  { name: IN_PROGRESS, color: "FBCA04", description: "An agent run is working this right now" },
  { name: HUMAN_REVIEW, color: "5319E7", description: "The agents are done. Waiting on a human." },
  { name: HUMAN_BLOCKED, color: "B60205", description: "A run ended without usable output. Needs a human decision." },
];

export interface CallerSpec {
  readonly file: string;
  readonly name: string;
  readonly trigger: string;
  readonly label: string;
  readonly workflow: string;
  readonly comment: string;
  /**
   * Granted by the caller, because a reusable workflow can only *narrow* what
   * it is given — never widen it.
   *
   * Most repositories default `GITHUB_TOKEN` to read-only, which is the right
   * setting. Without this block the called workflow asks for write against a
   * read-only grant and the run dies at startup with "the nested job is
   * requesting ... but is only allowed ...", before a single step executes.
   *
   * Keep each entry to what its workflow actually uses: review is
   * comment-only, and giving it `contents: write` would quietly undo the one
   * thing making that guarantee real.
   */
  readonly permissions: Record<string, string>;
}

export const CALLERS: readonly CallerSpec[] = [
  {
    file: "agent-implement.yml",
    name: "Agent Implement",
    trigger: "issues",
    label: TODO,
    workflow: "implement.yml",
    comment: "Implements an issue from scratch and opens a draft pull request.",
    // pull-requests: read is for preflight's `gh pr list` under GITHUB_TOKEN. It is
    // only observable on a private repository — a public one allows that read
    // without any grant at all.
    permissions: { issues: "write", contents: "read", "pull-requests": "read" },
  },
  {
    file: "agent-implement-pr.yml",
    name: "Agent Implement PR",
    trigger: "pull_request_target",
    label: TODO,
    workflow: "implement-pr.yml",
    comment:
      "Addresses the review feedback on a pull request. This is the end of the\n# chain: it never re-requests review, which is what stops the loop.",
    permissions: { contents: "write", "pull-requests": "write" },
  },
  {
    file: "agent-review.yml",
    name: "Agent Review",
    trigger: "pull_request_target",
    label: REVIEW,
    workflow: "review.yml",
    comment: "Reviews a pull request. Comment-only — the job has no contents: write.",
    // read, not write. Enough to clone the code under review, not enough to
    // change it — which is what makes "comment-only" enforced rather than
    // promised. Omitting `contents` altogether breaks the checkout.
    permissions: { contents: "read", "pull-requests": "write" },
  },
  {
    file: "agent-merge-main.yml",
    name: "Agent Merge Main",
    trigger: "pull_request_target",
    label: MERGE_MAIN,
    workflow: "merge-main.yml",
    comment: "Merges the base branch in. Never rebases — that would detach review comments.",
    permissions: { contents: "write", "pull-requests": "write" },
  },
];

export interface CallerOptions {
  /** Overrides the npm spec the called workflow runs. Accepts a git spec. */
  readonly packageSpec?: string;
  /**
   * Call the workflows by relative path instead of `owner/repo@ref`.
   *
   * Only meaningful inside this package's own repository, which installs its
   * own workflows so that main is exercised end to end after every merge. The
   * static tests catch shape errors on a pull request; this catches the ones
   * that only appear when GitHub actually runs the thing.
   */
  readonly local?: boolean;
}

export function callerWorkflow(spec: CallerSpec, options: CallerOptions = {}): string {
  const event =
    spec.trigger === "issues"
      ? "  issues:\n    types: [labeled]\n  workflow_dispatch:\n    inputs:\n      issue_number:\n        description: Issue number to work\n        required: true\n        type: string"
      : "  pull_request_target:\n    types: [labeled]";

  // pull_request_target runs with the repository's secrets and checks out the
  // head branch, so on a public repository a fork's code would execute with
  // your tokens the moment any collaborator applied a label. The same-repo
  // condition removes that path entirely. It costs nothing on a private
  // repository, where there are no fork pull requests to begin with.
  const guard =
    spec.trigger === "issues"
      ? `    if: github.event_name == 'workflow_dispatch' || github.event.label.name == '${spec.label}'`
      : `    if: >-\n      github.event.label.name == '${spec.label}'\n      && github.event.pull_request.head.repo.full_name == github.repository`;

  return `# ${spec.comment}
#
# Generated by \`npx @${OWNER.split("/")[0]}/agent-workflows init\`. The logic lives in
# ${OWNER}; this file only says when to run it. Settings are in
# ${CONFIG_FILENAME} — edit that, not this.

name: ${spec.name}

on:
${event}

jobs:
  run:
${guard}
    # Granted here, not in the called workflow: a reusable workflow can only
    # narrow what the caller gives it. Without this the run dies at startup.
    permissions:
${Object.entries(spec.permissions)
  .map(([scope, level]) => `      ${scope}: ${level}`)
  .join("\n")}
    uses: ${
  options.local
    ? `./.github/workflows/${spec.workflow}`
    : `${OWNER}/.github/workflows/${spec.workflow}@${WORKFLOW_REF}`
}
${withBlock(spec, options)}    secrets: inherit
`;
}

/**
 * The `with:` block, which exists only when there is something to pass.
 *
 * `package-spec` is how a project runs an unpublished build — npm compiles the
 * package from a git ref on install.
 */
function withBlock(spec: CallerSpec, options: CallerOptions): string {
  const lines: string[] = [];

  if (spec.trigger === "issues") {
    lines.push(
      "    # A reusable workflow cannot see the caller's inputs, so a manual run",
      "    # has to hand the issue number over explicitly.",
      "      issue_number: ${{ inputs.issue_number || '' }}",
    );
  }
  if (options.packageSpec) lines.push(`      package-spec: "${options.packageSpec}"`);
  // Locally, the CLI comes from the checkout rather than from a registry, so
  // the workflow runs the code in the commit under test.
  if (options.local) lines.push('      package-spec: "file:."');
  if (lines.length === 0) return "";

  // The comment lines have to precede `with:`, not sit inside it.
  const comments = lines.filter((line) => line.trimStart().startsWith("#"));
  const entries = lines.filter((line) => !line.trimStart().startsWith("#"));
  return `${[...comments, "    with:", ...entries].join("\n")}\n`;
}

/** A config that will not run until someone fills in `verify`. */
export function starterConfig(detected: Partial<ConfigInput> = {}): ConfigInput {
  return {
    verify: detected.verify ?? ["npm run typecheck", "npm test"],
    setup: detected.setup ?? ["npm ci"],
    ...detected,
  };
}

/** Reads the project's package.json to guess `verify`, rather than assuming. */
function detect(cwd: string): Partial<ConfigInput> {
  const path = join(cwd, "package.json");
  if (!existsSync(path)) return {};

  try {
    const pkg = JSON.parse(readFileSync(path, "utf8")) as { scripts?: Record<string, string> };
    const scripts = pkg.scripts ?? {};
    const verify: string[] = [];
    for (const candidate of ["typecheck", "check-types", "lint", "test"]) {
      if (scripts[candidate]) verify.push(`npm run ${candidate}`);
    }
    return verify.length > 0 ? { verify } : {};
  } catch {
    return {};
  }
}

/** Run artifacts sandcastle leaves in the repository. */
const IGNORED = [".sandcastle/worktrees/", ".sandcastle/logs/"] as const;

/** True when .gitignore already covers this path, exactly or via a parent. */
export function ignoredAlready(gitignore: string, entry: string): boolean {
  const trimmed = entry.replace(/\/$/, "");
  const parent = trimmed.split("/")[0] ?? trimmed;
  return gitignore
    .split("\n")
    .map((line) => line.trim().replace(/\/$/, ""))
    .some((line) => line === trimmed || line === parent);
}

export interface InitResult {
  readonly written: string[];
  readonly skipped: string[];
  readonly labels: string[];
  readonly warnings: string[];
}

export interface InitOptions {
  /** Overrides the npm spec in the generated callers. Accepts a git ref. */
  readonly packageSpec?: string;
  /** Call the workflows by relative path — this package's own repository only. */
  readonly local?: boolean;
}

export async function init(cwd = process.cwd(), options: InitOptions = {}): Promise<void> {
  const result: InitResult = { written: [], skipped: [], labels: [], warnings: [] };
  const written = result.written as string[];
  const skipped = result.skipped as string[];
  const labels = result.labels as string[];
  const warnings = result.warnings as string[];

  // Caller workflows are always rewritten: they are generated, they are tiny,
  // and a stale one silently points at an old ref.
  const dir = join(cwd, ".github", "workflows");
  mkdirSync(dir, { recursive: true });
  for (const spec of CALLERS) {
    writeFileSync(join(dir, spec.file), callerWorkflow(spec, options));
    written.push(`.github/workflows/${spec.file}`);
  }

  // The config is yours. Never overwritten.
  const configPath = join(cwd, CONFIG_FILENAME);
  if (existsSync(configPath)) {
    skipped.push(`${CONFIG_FILENAME} (already exists — left alone)`);
  } else {
    writeFileSync(configPath, `${JSON.stringify(starterConfig(detect(cwd)), null, 2)}\n`);
    written.push(CONFIG_FILENAME);
  }

  // Only the volatile subdirectories. Ignoring all of `.sandcastle/` would be
  // wrong for any project that also runs sandcastle locally — that directory
  // holds tracked source there, and swallowing it hides real files.
  const ignorePath = join(cwd, ".gitignore");
  const before = existsSync(ignorePath) ? readFileSync(ignorePath, "utf8") : "";
  const missing = IGNORED.filter((entry) => !ignoredAlready(before, entry));
  if (missing.length > 0) {
    const separator = before === "" || before.endsWith("\n") ? "" : "\n";
    writeFileSync(ignorePath, `${before}${separator}\n# agent-workflows run artifacts\n${missing.join("\n")}\n`);
    written.push(`.gitignore (added ${missing.join(", ")})`);
  }

  // --force so a deleted or recoloured label heals rather than erroring.
  const repo = tryGh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
  if (repo.ok) {
    for (const label of LABELS) {
      const created = tryGh([
        "label", "create", label.name, "--force",
        "--color", label.color, "--description", label.description,
      ]);
      if (created.ok) labels.push(label.name);
      else warnings.push(`Could not create the label \`${label.name}\`: ${created.output.trim()}`);
    }
  } else {
    warnings.push(
      "Not in a GitHub repository, or `gh` is not authenticated — no labels were created. Run `gh auth login`, then re-run this.",
    );
  }

  const secrets = tryGh(["secret", "list", "--json", "name", "--jq", ".[].name"]);
  if (secrets.ok) {
    const present = new Set(secrets.output.split("\n").map((line) => line.trim()));
    for (const secret of ["AGENT_GH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"]) {
      if (!present.has(secret)) {
        warnings.push(`The repository secret \`${secret}\` is not set. Nothing will run without it.`);
      }
    }
  }

  print(result);
}

function print(result: InitResult): void {
  console.log("\nWrote:");
  for (const file of result.written) console.log(`  ${file}`);
  for (const file of result.skipped) console.log(`  ${file}`);

  if (result.labels.length > 0) {
    console.log(`\nLabels ready: ${result.labels.join(", ")}`);
  }

  if (result.warnings.length > 0) {
    console.log("\nStill needed:");
    for (const warning of result.warnings) console.log(`  - ${warning}`);
  }

  console.log(`
Next:
  1. Open ${CONFIG_FILENAME} and check \`verify\` — it must be the same commands
     your pull request checks run, or an agent can "pass" something CI fails.
  2. Set the two repository secrets if they were listed above:
       gh secret set AGENT_GH_TOKEN          # PAT: contents, issues, PRs, workflow
       gh secret set CLAUDE_CODE_OAUTH_TOKEN # from \`claude setup-token\`
  3. Commit, push, then label an issue \`${TODO}\`.
`);
}
