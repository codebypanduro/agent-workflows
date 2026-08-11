import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CALLERS, callerWorkflow, ignoredAlready, LABELS, starterConfig } from "./init.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const reusable = (name: string): string =>
  readFileSync(join(repoRoot, ".github", "workflows", name), "utf8");

/**
 * The job-level `permissions:` block of a reusable workflow.
 *
 * Hand-parsed rather than run through a YAML library so the test has no
 * dependency the package itself does not need. Comments and blank lines are
 * skipped — the review workflow explains its lack of `contents: write` inside
 * its own block, and that comment is worth keeping.
 */
function declaredPermissions(yaml: string): Record<string, string> | null {
  const lines = yaml.split("\n");
  const start = lines.findIndex((line) => line === "    permissions:");
  if (start === -1) return null;

  const permissions: Record<string, string> = {};
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const entry = /^ {6}([\w-]+):\s*(\S+)\s*$/.exec(line);
    if (!entry) break;
    permissions[entry[1]!] = entry[2]!;
  }
  return permissions;
}

describe("generated caller workflows", () => {
  // The bug this pins: a reusable workflow can only *narrow* the caller's
  // permissions. With most repositories defaulting GITHUB_TOKEN to read-only,
  // a caller that declares nothing makes the called workflow's write request
  // illegal, and the run dies at startup before any step executes.
  it("grants at least what the workflow it calls asks for", () => {
    for (const spec of CALLERS) {
      const needed = declaredPermissions(reusable(spec.workflow));
      expect(needed, `${spec.workflow} declares no permissions`).not.toBeNull();
      expect(Object.keys(needed!).length, `${spec.workflow} has an empty permissions block`)
        .toBeGreaterThan(0);

      for (const [scope, level] of Object.entries(needed!)) {
        expect(
          spec.permissions[scope],
          `${spec.file} must grant ${scope}: ${level} for ${spec.workflow}`,
        ).toBe(level);
      }
    }
  });

  // Widening is as much a bug as narrowing, in the one case where the absence
  // of a permission is the feature.
  it("gives the reviewer read access and no more", () => {
    const reviewCaller = CALLERS.find((spec) => spec.workflow === "review.yml");

    // Not `undefined`: without contents: read the checkout fails, and on a
    // private repository it fails as "Repository not found".
    expect(reviewCaller?.permissions.contents).toBe("read");
    expect(reusable("review.yml")).not.toMatch(/^\s+contents: write$/m);
  });

  // Every workflow that checks the repository out needs to be able to read it.
  it("grants contents: read to every caller whose workflow checks out code", () => {
    for (const spec of CALLERS) {
      if (!reusable(spec.workflow).includes("actions/checkout")) continue;

      expect(
        spec.permissions.contents,
        `${spec.file} checks out code but grants no contents permission`,
      ).toMatch(/^(read|write)$/);
    }
  });

  it("emits the permissions block before the uses line", () => {
    const yaml = callerWorkflow(CALLERS[0]!);

    expect(yaml.indexOf("permissions:")).toBeLessThan(yaml.indexOf("uses:"));
    expect(yaml).toContain("issues: write");
  });

  it("passes a package spec through only when one is given", () => {
    expect(callerWorkflow(CALLERS[0]!)).not.toContain("package-spec");
    expect(callerWorkflow(CALLERS[0]!, "github:x/y#v1")).toContain(
      'package-spec: "github:x/y#v1"',
    );
  });

  it("hands the dispatch input through, since a reusable workflow cannot see it", () => {
    const issueCaller = CALLERS.find((spec) => spec.trigger === "issues")!;

    expect(callerWorkflow(issueCaller)).toContain("issue_number: ${{ inputs.issue_number || '' }}");
  });

  it("points every caller at a workflow that exists and accepts workflow_call", () => {
    for (const spec of CALLERS) {
      expect(reusable(spec.workflow)).toMatch(/^on:\n {2}workflow_call:/m);
    }
  });

  it("guards on the label that triggers it", () => {
    for (const spec of CALLERS) {
      expect(callerWorkflow(spec)).toContain(`== '${spec.label}'`);
    }
  });
});

describe("labels", () => {
  it("covers every label the workflows read or write", () => {
    const names = LABELS.map((label) => label.name);

    expect(names).toEqual([
      "agent:todo",
      "agent:review",
      "agent:merge-main",
      "agent:in-progress",
      "human:review",
      "human:blocked",
    ]);
  });
});

describe("starterConfig", () => {
  it("prefers what was detected over the guess", () => {
    expect(starterConfig({ verify: ["pnpm test"] }).verify).toEqual(["pnpm test"]);
  });

  it("still produces something runnable when nothing was detected", () => {
    expect(starterConfig().verify.length).toBeGreaterThan(0);
  });
});

describe("ignoredAlready", () => {
  it("sees an exact entry", () => {
    expect(ignoredAlready("node_modules\n.sandcastle/worktrees/", ".sandcastle/worktrees/")).toBe(true);
  });

  // A project that ignores the whole directory does not need the subpaths.
  it("sees a parent entry covering it", () => {
    expect(ignoredAlready(".sandcastle/\n", ".sandcastle/worktrees/")).toBe(true);
  });

  it("does not confuse a similarly named entry", () => {
    expect(ignoredAlready(".sandcastle-old/\n", ".sandcastle/worktrees/")).toBe(false);
    expect(ignoredAlready("", ".sandcastle/logs/")).toBe(false);
  });
});
