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

describe("every workflow file", () => {
  it("is covered by this test", () => {
    const present = readdirSync(workflowDir).filter((name) => name.endsWith(".yml"));

    expect(present.sort()).toEqual([...REUSABLE, "test.yml"].sort());
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
});
