// Static checks on the reusable workflow files.
//
// These exist because every one of them has already cost a broken run in
// production. GitHub validates workflow YAML only on push, and a validation
// failure produces no job and no log — just an annotation on the run summary.
// That is a bad feedback loop to rely on, so the rules it enforces are pinned
// here instead.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const workflowDir = join(dirname(dirname(fileURLToPath(import.meta.url))), ".github", "workflows");

const REUSABLE = ["implement.yml", "implement-pr.yml", "review.yml", "merge-main.yml"];

const read = (name: string): string => readFileSync(join(workflowDir, name), "utf8");

/**
 * The lines of a job-level `env:` block — the ones between `    env:` and the
 * `    steps:` that follows it.
 */
function jobEnvLines(yaml: string): string[] {
  const lines = yaml.split("\n");
  const start = lines.findIndex((line) => line === "    env:");
  if (start === -1) return [];

  const collected: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^ {4}\S/.test(line)) break;
    collected.push(line);
  }
  return collected;
}

/** The callers this repository generated for itself, to run its own workflows. */
const DOGFOOD = REUSABLE.map((name) => `agent-${name}`);

describe("every workflow file", () => {
  it("is covered by this test", () => {
    const present = readdirSync(workflowDir).filter((name) => name.endsWith(".yml"));

    expect(present.sort()).toEqual([...REUSABLE, ...DOGFOOD, "test.yml"].sort());
  });
});

// This repository installs its own workflows, so that main is exercised for
// real after every merge — the static checks below only catch what can be seen
// without running anything.
describe("dogfooding", () => {
  it("has a caller for every reusable workflow", () => {
    for (const name of DOGFOOD) {
      expect(readdirSync(workflowDir)).toContain(name);
    }
  });

  it("calls them by relative path, so a run tests this commit", () => {
    for (const [i, name] of DOGFOOD.entries()) {
      expect(read(name)).toContain(`uses: ./.github/workflows/${REUSABLE[i]}`);
    }
  });

  it("runs the CLI from the checkout rather than a registry", () => {
    for (const name of DOGFOOD) {
      expect(read(name)).toContain('package-spec: "file:."');
    }
  });

  // This repository is public, so an unguarded pull_request_target caller would
  // run a fork's code with its secrets on any label click.
  it("never runs a fork's code", () => {
    for (const name of DOGFOOD) {
      if (!read(name).includes("pull_request_target")) continue;

      expect(read(name), `${name} would run fork code with repository secrets`).toContain(
        "github.event.pull_request.head.repo.full_name == github.repository",
      );
    }
  });
});

describe("contexts available at job level", () => {
  // Cost two broken deployments. `runner` exists only inside steps, and using
  // it in a job-level `env:` block invalidates the *entire file* — so all four
  // workflows fail at once, including the three the label did not target.
  it("never uses the runner context in a job-level env block", () => {
    for (const name of REUSABLE) {
      const offending = jobEnvLines(read(name)).filter((line) => /\$\{\{\s*runner\./.test(line));

      expect(offending, `${name} uses runner.* in its job env; use $RUNNER_TEMP in a step`).toEqual(
        [],
      );
    }
  });

  it("only uses contexts that exist at job level", () => {
    const allowed = new Set(["github", "secrets", "inputs", "needs", "vars", "matrix", "strategy"]);

    for (const name of REUSABLE) {
      for (const line of jobEnvLines(read(name))) {
        for (const [, context] of line.matchAll(/\$\{\{\s*([a-z]+)\./g)) {
          expect(allowed.has(context!), `${name}: '${context}' is not available in a job env block`)
            .toBe(true);
        }
      }
    }
  });
});

describe("inputs", () => {
  it("declares every input it references", () => {
    for (const name of REUSABLE) {
      const yaml = read(name);
      const declared = new Set(
        [...yaml.matchAll(/^ {6}([\w-]+):$/gm)].map((match) => match[1]!),
      );

      for (const [, used] of yaml.matchAll(/\$\{\{[^}]*?inputs\.([\w-]+)/g)) {
        expect(declared.has(used!), `${name} uses inputs.${used} without declaring it`).toBe(true);
      }
    }
  });
});

describe("the shape every reusable workflow has to have", () => {
  it("is callable", () => {
    for (const name of REUSABLE) {
      expect(read(name)).toMatch(/^on:\n {2}workflow_call:/m);
    }
  });

  // A shallow fetch of the base ref leaves origin/$BASE_REF without a common
  // ancestor, so a later merge fails instantly with a misleading error.
  it("never fetches the base ref shallowly", () => {
    for (const name of REUSABLE) {
      expect(read(name), `${name} fetches $BASE_REF with --depth`).not.toMatch(
        /git fetch[^\n]*--depth[^\n]*BASE_REF/,
      );
    }
  });

  it("takes its config from the base branch, never the checked-out head", () => {
    for (const name of REUSABLE) {
      const yaml = read(name);

      expect(yaml, `${name} does not read config from the base ref`).toContain(
        'git show "origin/$BASE_REF:agent-workflows.config.json"',
      );
      expect(yaml).toContain('echo "AGENT_WORKFLOWS_CONFIG=');
    }
  });

  // Without this an object sits on agent:in-progress forever, which is the one
  // failure the whole lifecycle table exists to prevent.
  it("always reaches a terminal label, even when everything above it failed", () => {
    for (const name of REUSABLE) {
      const yaml = read(name);

      expect(yaml).toContain("Decide the terminal label");
      expect(yaml).toContain("Fall back to a bare failure label");
      expect(yaml.match(/if: always\(\)/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    }
  });

  it("keeps the reviewer unable to write to the repository", () => {
    expect(read("review.yml")).not.toMatch(/^ {6}contents: write$/m);
  });

  // Every reusable workflow shells out to a CLI command that inspects pull
  // requests — implement's is the least obvious, since preflight lists them only
  // to avoid opening a duplicate. A public repository lets GITHUB_TOKEN make that
  // read with no grant at all, so a missing permission here is invisible until
  // the first private consumer installs it and dies on "Resource not accessible
  // by integration". implement.yml shipped without it for exactly that reason.
  it("grants pull-requests on every reusable workflow and its caller", () => {
    for (const name of REUSABLE) {
      expect(read(name), `${name} never grants pull-requests`).toMatch(
        /^ {6}pull-requests: (read|write)$/m,
      );
    }

    for (const name of DOGFOOD) {
      expect(read(name), `${name} does not pass pull-requests through`).toMatch(
        /^ {6}pull-requests: (read|write)$/m,
      );
    }
  });
});
