import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.ts";
import { loadPrompt } from "./prompts.ts";

const config = (over: Record<string, unknown> = {}) =>
  parseConfig(JSON.stringify({ verify: ["npm test"], ...over }));

describe("loadPrompt", () => {
  it("ships a prompt for every workflow", () => {
    for (const name of ["implement", "implement-pr", "review", "merge-main"] as const) {
      expect(loadPrompt(name, config()).length).toBeGreaterThan(200);
    }
  });

  it("appends nothing when the project has said nothing", () => {
    const plain = loadPrompt("implement", config());

    expect(plain).not.toContain("ABOUT THIS CODEBASE");
    expect(plain).not.toContain("PROJECT STANDARDS");
  });

  // The escape hatch that should cover most projects — it composes with an
  // upstream prompt instead of replacing it.
  it("appends project notes and a standards pointer", () => {
    const prompt = loadPrompt(
      "implement",
      config({ prompts: { notes: "No live database in CI.", codingStandards: "CONTRIBUTING.md" } }),
    );

    expect(prompt).toContain("No live database in CI.");
    expect(prompt).toContain("@CONTRIBUTING.md");
    // Appended, so the upstream prompt is still all there.
    expect(prompt.indexOf("No live database in CI.")).toBeGreaterThan(200);
  });

  // Its shape is a contract with the review parser, so prose appended to it
  // only gives the model more ways to get the tag wrong.
  it("never decorates the extraction prompt", () => {
    const prompt = loadPrompt("review-extraction", config({ prompts: { notes: "Hello." } }));

    expect(prompt).not.toContain("Hello.");
    expect(prompt).toContain("<output>");
  });

  it("keeps the review prompt's inline-comment rules, which the filter depends on", () => {
    expect(loadPrompt("review-extraction", config())).toContain("right-hand side of the diff");
  });

  it("tells every code-writing prompt not to delete tests to go green", () => {
    for (const name of ["implement", "implement-pr", "merge-main"] as const) {
      expect(loadPrompt(name, config())).toMatch(/deleting it, skipping it, or weakening/);
    }
  });
});
