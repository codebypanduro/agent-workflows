// IO helpers shared by every agent workflow entrypoint.
//
// Everything here is deliberately thin. The branchy logic lives in
// lifecycle.mts, test-guard.mts and pr-context.mts, all of which are pure and
// unit tested; these are the bits that touch the process, the filesystem and
// the `gh` CLI.

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as sandcastle from "@ai-hero/sandcastle";
import type { AgentProvider } from "@ai-hero/sandcastle";
import type { Config } from "../config.ts";

/**
 * Where the workflow looks for the files a run leaves behind.
 *
 * `RUNNER_TEMP` is read directly rather than passed in as `OUTPUT_DIR`, because
 * the `runner` context is not available in a job-level `env:` block — only in
 * steps — and setting it per step in four workflows is four places to forget.
 * `OUTPUT_DIR` still wins when set, which is how you run these by hand.
 */
export const outputDir = (): string =>
  process.env.OUTPUT_DIR || process.env.RUNNER_TEMP || "/tmp";

export function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function optional(name: string): string | undefined {
  return process.env[name] || undefined;
}

export function writeOutput(name: string, contents: string): string {
  const dir = outputDir();
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, contents);
  return path;
}

export const writeJson = (name: string, value: unknown): string =>
  writeOutput(name, `${JSON.stringify(value, null, 2)}\n`);

/**
 * Reports how the run ended, for `transition.mts` to turn into a label.
 *
 * The run always exits 0 after calling this. A non-zero exit is reserved for
 * genuine crashes, which are the one outcome a run cannot report about itself
 * — the workflow's failure handler picks those up as `crashed`.
 */
export function report(outcome: string, detail?: string): void {
  const outputs: Record<string, string> = { outcome };
  if (detail !== undefined) outputs.detail = detail;

  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput) {
    const delimiter = "SANDCASTLE_EOF";
    const lines = Object.entries(outputs).map(
      ([key, value]) => `${key}<<${delimiter}\n${value}\n${delimiter}`,
    );
    appendFileSync(githubOutput, `${lines.join("\n")}\n`);
  }

  console.log(`\nRun outcome: ${outcome}${detail ? ` (${detail})` : ""}`);
}

/**
 * Aborts the run with a reason a human will read on the issue or pull request.
 *
 * Written to a file as well as reported, so a crash *after* this point still
 * surfaces the real cause rather than a bare `crashed`.
 */
export function fail(message: string): never {
  console.error(`\nFAILED: ${message}`);
  writeOutput("failure_reason.txt", message);
  process.exit(1);
}

export function gh(args: readonly string[]): string {
  return execFileSync("gh", [...args], {
    encoding: "utf8",
    // stderr is piped, not inherited: `tryGh` reports it when it matters, and
    // an expected 404 should not print a scary line in a green log.
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 32 * 1024 * 1024,
  });
}

/** `gh` against the repository the workflow is running in. */
export function ghRepo(args: readonly string[]): string {
  return gh([...args, "-R", required("REPO")]);
}

/** `gh`, but a non-zero exit is a value rather than a throw. */
export function tryGh(args: readonly string[]): { ok: boolean; output: string } {
  try {
    return { ok: true, output: gh(args) };
  } catch (error) {
    const shaped = error as { stdout?: string; stderr?: string };
    return { ok: false, output: `${shaped.stdout ?? ""}${shaped.stderr ?? ""}` };
  }
}

/**
 * Writes key/value pairs to `GITHUB_OUTPUT` in heredoc form.
 *
 * Heredoc unconditionally, because half of what goes through here is a comment
 * body containing backticks and newlines.
 */
export function emit(outputs: Record<string, string>): void {
  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput) {
    const delimiter = "SANDCASTLE_EOF";
    appendFileSync(
      githubOutput,
      `${Object.entries(outputs)
        .map(([key, value]) => `${key}<<${delimiter}\n${value}\n${delimiter}`)
        .join("\n")}\n`,
    );
  }
  console.log(JSON.stringify(outputs, null, 2));
}

export function git(args: readonly string[]): string {
  return execFileSync("git", [...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 32 * 1024 * 1024,
  });
}

/** `git`, but a non-zero exit is a value rather than a throw. */
export function tryGit(args: readonly string[]): { ok: boolean; output: string } {
  try {
    return { ok: true, output: git(args) };
  } catch (error) {
    const shaped = error as { stdout?: string; stderr?: string };
    return { ok: false, output: `${shaped.stdout ?? ""}${shaped.stderr ?? ""}` };
  }
}

// Annotated rather than inferred: claudeCode()'s return type references an
// internal sandcastle type, which blocks declaration emit.
export const agent = (config: Config): AgentProvider =>
  sandcastle.claudeCode(config.model, {
    env: {
      CLAUDE_CODE_OAUTH_TOKEN: required("CLAUDE_CODE_OAUTH_TOKEN"),
      ...config.env,
    },
  });

/** Wraps a run so any throw becomes a readable `failure_reason.txt`. */
export async function main(body: () => Promise<void>): Promise<void> {
  try {
    await body();
  } catch (error) {
    fail(error instanceof Error ? (error.stack ?? error.message) : String(error));
  }
}

/**
 * Sets the identity the agent commits under.
 *
 * Done here rather than in YAML so the config file stays the single place a
 * project describes itself — the workflows would otherwise need their own
 * parser for it.
 */
export function configureGitIdentity(config: Config): void {
  git(["config", "--global", "user.name", config.git.name]);
  git(["config", "--global", "user.email", config.git.email]);
}
