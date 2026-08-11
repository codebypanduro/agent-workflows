// Loading a prompt, and the two hooks a project has for changing one.
//
// The prompts ship with the package because they are the part most worth
// sharing: a review prompt that has been tuned against real pull requests is
// more valuable than one each project writes once and never revisits.
//
// So overriding a whole prompt is possible and discouraged — a forked prompt
// stops receiving improvements. `notes` and `codingStandards` cover almost
// every real case, and they compose with upstream changes instead of replacing
// them.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "./config.ts";

export type PromptName = "implement" | "implement-pr" | "review" | "review-extraction" | "merge-main";

/** Prompts live beside `dist/`, not inside it — `files` in package.json ships them. */
const packagedPrompt = (name: PromptName): string =>
  join(dirname(dirname(fileURLToPath(import.meta.url))), "prompts", `${name}.md`);

const OVERRIDES: Record<PromptName, (config: Config) => string | undefined> = {
  implement: (c) => c.prompts.implement,
  "implement-pr": (c) => c.prompts.implementPr,
  review: (c) => c.prompts.review,
  "merge-main": (c) => c.prompts.mergeMain,
  // Deliberately not overridable: its shape is coupled to the schema the review
  // command parses, so a project rewriting it would break parsing rather than
  // change behaviour.
  "review-extraction": () => undefined,
};

/**
 * Renders the project's addenda.
 *
 * Appended rather than interpolated, so a prompt improving upstream never has
 * to know a project exists.
 */
function addenda(config: Config): string {
  const blocks: string[] = [];

  if (config.prompts.codingStandards) {
    blocks.push(
      `# PROJECT STANDARDS\n\nFollow the conventions in @${config.prompts.codingStandards}. Where they disagree with your instincts, they win.`,
    );
  }

  if (config.prompts.notes) {
    blocks.push(`# ABOUT THIS CODEBASE\n\n${config.prompts.notes}`);
  }

  return blocks.length > 0 ? `\n\n${blocks.join("\n\n")}\n` : "";
}

export interface LoadedPrompt {
  /** Absolute path to a file the agent runner can be pointed at. */
  readonly path: string;
  readonly contents: string;
}

/**
 * Resolves a prompt to text, with the project's addenda appended.
 *
 * Returns the contents rather than only a path because the addenda mean the
 * file on disk is not what the agent should receive; callers that need a path
 * write the result to the run's output directory.
 */
export function loadPrompt(name: PromptName, config: Config, cwd = process.cwd()): string {
  const override = OVERRIDES[name](config);
  const path = override ? resolve(cwd, override) : packagedPrompt(name);
  const base = readFileSync(path, "utf8");

  // The extraction prompt is a format contract, not instructions — appending
  // prose to it only gives the model more ways to get the tag wrong.
  if (name === "review-extraction") return base;

  return `${base}${addenda(config)}`;
}

/**
 * Writes a resolved prompt to disk and returns its path.
 *
 * The agent runner takes a file, and the file on disk is never what the agent
 * should receive once the project's addenda are appended — so every run
 * materialises its prompts into the run's output directory rather than
 * pointing at the package.
 */
export function materialisePrompt(
  name: PromptName,
  config: Config,
  dir: string,
  cwd = process.cwd(),
): string {
  const path = join(dir, `${name}.prompt.md`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, loadPrompt(name, config, cwd));
  return path;
}
