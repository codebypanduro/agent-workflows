#!/usr/bin/env node
// The one entrypoint. Every workflow step is `agent-workflows <command>`, so
// the YAML in a consuming project stays a trigger and nothing else.

import { ConfigError, loadConfig } from "./config.ts";
import { implement } from "./commands/implement.ts";
import { implementPr } from "./commands/implement-pr.ts";
import { init } from "./commands/init.ts";
import { mergeMain } from "./commands/merge-main.ts";
import { preflightImplement, preflightImplementPr } from "./commands/preflight.ts";
import { review } from "./commands/review.ts";
import { transition } from "./commands/transition.ts";
import { fail } from "./shared/common.ts";

const USAGE = `agent-workflows <command>

Setup
  init                     Scaffold the caller workflows, config and labels

Run (called by the reusable workflows; you should not need these by hand)
  implement                Implement an issue on a fresh branch
  implement-pr             Address the review feedback on a pull request
  review                   Review a pull request and emit the payload
  merge-main               Merge the base branch in, resolving conflicts
  preflight-implement      Decide whether an implement run should start
  preflight-implement-pr   Decide whether a feedback run has anything to do
  transition               Map a run outcome to a label transition
`;

const command = process.argv[2];

try {
  switch (command) {
    case "init":
      await init();
      break;

    // Reads no config: it is pure outcome-to-label logic, and it has to work
    // even on the path where loading the config is what failed.
    case "transition":
      transition();
      break;

    case "implement":
      await implement(loadConfig());
      break;
    case "implement-pr":
      await implementPr(loadConfig());
      break;
    case "review":
      await review(loadConfig());
      break;
    case "merge-main":
      await mergeMain(loadConfig());
      break;
    case "preflight-implement":
      await preflightImplement(loadConfig());
      break;
    case "preflight-implement-pr":
      await preflightImplementPr(loadConfig());
      break;

    case "--help":
    case "-h":
    case undefined:
      console.log(USAGE);
      break;

    default:
      console.error(`Unknown command: ${command}\n`);
      console.error(USAGE);
      process.exit(1);
  }
} catch (error) {
  // A bad config is a mistake in the consuming repo, not a crash — say so
  // without a stack trace nobody can act on.
  if (error instanceof ConfigError) fail(error.message);
  fail(error instanceof Error ? (error.stack ?? error.message) : String(error));
}
