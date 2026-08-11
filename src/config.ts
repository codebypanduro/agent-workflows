// Everything a project has to tell the workflows about itself.
//
// The split between this and the rest of the package is the whole point of
// extracting it: what is *generic* (the lifecycle, the chain, the guard, the
// prompts) lives in the package and improves for every project at once; what is
// *specific* (how to install, how to verify, what the agent should know about
// this codebase) lives in one JSON file per repo.
//
// If you find yourself wanting to fork a prompt, check `prompts.notes` first —
// most project-specific prompt content is a paragraph, not a rewrite.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

export const CONFIG_FILENAME = "agent-workflows.config.json";

const gitIdentitySchema = z.object({
  name: z.string().min(1),
  email: z.string().min(1),
});

export const configSchema = z.object({
  /**
   * Commands that decide whether a branch is good.
   *
   * Required, and deliberately without a default: this is the one setting that
   * cannot be guessed, and a wrong guess means an agent "passing" something the
   * pull request would fail. It must be the same set your PR checks run.
   */
  verify: z.array(z.string().min(1)).min(1),

  /**
   * Commands run inside the fresh worktree before the agent starts.
   *
   * The worktree is a clean checkout, so anything the tests need to exist —
   * installed dependencies, a generated client, a built package — belongs here.
   */
  setup: z.array(z.string().min(1)).default(["npm ci"]),

  /** Environment for the agent and for every verify/setup command. */
  env: z.record(z.string(), z.string()).default({}),

  model: z.string().default("claude-opus-5"),

  /** Node version the reusable workflows install. */
  nodeVersion: z.string().default("22"),

  /**
   * Retry laps after the first failed verification.
   *
   * 0 disables the self-repair loop. The test guard still runs — it is not
   * coupled to retrying, and there is no configuration that turns it off.
   */
  maxRetries: z.number().int().min(0).max(5).default(2),

  /** Branch name for an issue run. `{issue}` is substituted. */
  branchPattern: z.string().default("agent/issue-{issue}"),

  /** Commit-message prefix. Also how the package recognises its own commits. */
  commitPrefix: z.string().default("agent:"),

  /** Identity the agent commits under. */
  git: gitIdentitySchema.default({
    name: "agent",
    email: "agent@users.noreply.github.com",
  }),

  /**
   * The GitHub login whose review replies mean "already handled".
   *
   * Defaults to the repository owner at runtime, which is right whenever the
   * PAT belongs to you. Set it explicitly if the agent posts as someone else.
   */
  agentLogin: z.string().optional(),

  /** Who gets assigned work the agent files. Omit for nobody. */
  assignee: z.string().optional(),

  prompts: z
    .object({
      /**
       * A file the agent is told to follow — coding standards, conventions.
       * Path relative to the repository root.
       */
      codingStandards: z.string().optional(),
      /**
       * Free text appended to every code-writing prompt.
       *
       * This is where environment quirks go: "no live database is available",
       * "the API must be running for integration tests", "never edit
       * generated/". Shorter and more durable than forking a prompt.
       */
      notes: z.string().optional(),
      /** Per-workflow prompt overrides, by path. Use sparingly. */
      implement: z.string().optional(),
      implementPr: z.string().optional(),
      review: z.string().optional(),
      mergeMain: z.string().optional(),
    })
    .default({}),
});

export type Config = z.output<typeof configSchema>;
export type ConfigInput = z.input<typeof configSchema>;

export class ConfigError extends Error {}

/** Walks up from `start` looking for the config file. */
export function findConfig(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    const candidate = join(dir, CONFIG_FILENAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Parses and validates, turning zod's report into something readable in a log. */
export function parseConfig(raw: string, source = CONFIG_FILENAME): Config {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new ConfigError(
      `${source} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const result = configSchema.safeParse(json);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new ConfigError(`${source} is not valid:\n${problems}`);
  }

  return result.data;
}

export function loadConfig(cwd = process.cwd()): Config {
  const path = findConfig(cwd);
  if (!path) {
    throw new ConfigError(
      `No ${CONFIG_FILENAME} found in ${cwd} or any parent. Run \`npx @codebypanduro/agent-workflows init\` to create one.`,
    );
  }
  return parseConfig(readFileSync(path, "utf8"), path);
}

export const branchFor = (config: Config, issue: string | number): string =>
  config.branchPattern.replaceAll("{issue}", String(issue));
