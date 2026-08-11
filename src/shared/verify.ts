// Verification and the self-repair loop (docs/adr/0008).
//
// `VERIFY_COMMANDS` is the single source of truth for "is this branch good".
// The same pair runs in the sandbox as the agent's own feedback signal and on
// the pull request via `.github/workflows/test.yml`. An agent must not be able
// to pass something the pull request would fail, so nothing here may diverge
// from that workflow.

import type { Sandbox, SandboxRunResult } from "@ai-hero/sandcastle";
import type { Config } from "../config.ts";
import { census, compareCensus, isTestFile, type GuardVerdict, type TestFile } from "./test-guard.ts";

export interface VerifyResult {
  /** The first command that failed, or `undefined` when the branch is green. */
  readonly failedCommand?: string;
  /** The tail of that command's output, for feeding back to the agent. */
  readonly output: string;
}

/** Runs the project's verify commands in order, stopping at the first failure. */
export async function verify(sandbox: Sandbox, config: Config): Promise<VerifyResult> {
  for (const command of config.verify) {
    console.log(`\nVerifying: ${command}`);
    const lines: string[] = [];
    const result = await sandbox.exec(command, {
      onLine: (line) => {
        console.log(`  ${line}`);
        lines.push(line);
      },
    });

    if (result.exitCode !== 0) {
      // The tail, not the whole log: a failing turbo run is thousands of lines
      // of cache hits and the failure is always at the bottom.
      return { failedCommand: command, output: lines.slice(-120).join("\n") };
    }
  }

  return { output: "" };
}

/** Reads every test file on the branch, for the guard to count. */
async function testFiles(sandbox: Sandbox): Promise<TestFile[]> {
  const listed = await sandbox.exec("git ls-files");
  const paths = listed.stdout.split("\n").map((line) => line.trim()).filter(isTestFile);

  const files: TestFile[] = [];
  for (const path of paths) {
    // `git show` rather than `cat`: it reads the committed state, so an
    // uncommitted scratch edit cannot make the census lie either way.
    const shown = await sandbox.exec(`git show HEAD:${path}`);
    if (shown.exitCode === 0) files.push({ path, contents: shown.stdout });
  }
  return files;
}

export type LoopOutcome =
  | { kind: "checks-passed" }
  | { kind: "checks-failed"; failedCommand: string }
  | { kind: "test-guard-tripped"; detail: string };

function retryPrompt(result: VerifyResult, attempt: number, total: number): string {
  return [
    `\`${result.failedCommand}\` failed on this branch. This is retry ${attempt} of ${total}.`,
    "",
    "Output (tail):",
    "",
    "```",
    result.output,
    "```",
    "",
    "Fix the underlying problem and commit. Do not delete, skip, or weaken any test to make this pass — a check runs after you and will stop the run if the suite shrinks, which wastes the attempt and blocks the pull request. If you genuinely believe a test is wrong, leave it failing and say so instead.",
  ].join("\n");
}

/**
 * Verifies the branch, and on failure hands the output back to the agent that
 * produced it — same session, so it can see what it already tried.
 *
 * The guard runs after every lap the agent touches. It compares the committed
 * test files either side and stops the run if coverage shrank, whatever
 * verification reported.
 */
export async function verifyWithRepair(
  sandbox: Sandbox,
  run: SandboxRunResult,
  config: Config,
): Promise<LoopOutcome> {
  const maxRetries = config.maxRetries;
  let current = run;
  let before = census(await testFiles(sandbox));

  for (let attempt = 0; ; attempt += 1) {
    const result = await verify(sandbox, config);
    if (!result.failedCommand) return { kind: "checks-passed" };

    if (attempt >= maxRetries) {
      console.log(`\n${result.failedCommand} still failing after ${attempt} retr(y|ies). Giving up.`);
      return { kind: "checks-failed", failedCommand: result.failedCommand };
    }

    if (!current.resume) {
      // No captured session to continue — a non-Claude provider, or capture
      // disabled. Retrying from scratch would re-read the whole repo without
      // knowing what already failed, so it is not worth the eight minutes.
      console.log("\nNo resumable session; not retrying.");
      return { kind: "checks-failed", failedCommand: result.failedCommand };
    }

    console.log(`\nRetry ${attempt + 1}/${maxRetries}: resuming the agent with the failure.`);
    current = await current.resume(retryPrompt(result, attempt + 1, maxRetries));

    const after = census(await testFiles(sandbox));
    const verdict: GuardVerdict = compareCensus(before, after);
    if (verdict.tripped) {
      console.error(`\nTest-deletion guard tripped: ${verdict.detail}`);
      return { kind: "test-guard-tripped", detail: verdict.detail };
    }
    before = after;
  }
}
