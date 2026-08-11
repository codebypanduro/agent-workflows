// Two-pass structured output.
//
// Constraining an agent to a schema while it is still working makes it worse at
// the work: it shapes its thinking around the fields it has to fill. So the
// producing run is unconstrained, and a second run resumes its session and asks
// only for the JSON.
//
// The retry matters as much as the split. `Output.object`'s `maxRetries`
// resumes the *extraction* session with a description of what failed to
// validate, so a malformed tag is re-emitted rather than losing the whole run —
// which is the failure `.github/seo/sweep.mts` currently throws on.
//
// Note this uses the top-level `run()`, not `sandbox.run()`: structured output
// lives on `RunOptions` only, and the sandbox handle's run options have no
// `output` field in @ai-hero/sandcastle 0.12. Workflows that need both a
// long-lived sandbox and structured output would have to fetch the session id
// and call `run({ resumeSession })` themselves — none currently do.
//
// Ported from mattpocock/sandcastle's own agent workflows.

import { run, type OutputObjectDefinition, type RunOptions, type RunResult } from "@ai-hero/sandcastle";

export interface ExtractionOptions<T> extends Omit<RunOptions, "output"> {
  readonly output: OutputObjectDefinition<T>;
  /** Asks for the tag and nothing else. Kept next to its prompt as extraction.md. */
  readonly extractionPrompt: string;
  /** Extra extraction attempts after the first. Default 2. */
  readonly maxRetries?: number;
}

export async function runWithExtraction<T>(
  options: ExtractionOptions<T>,
): Promise<RunResult & { output: T }> {
  const { output, extractionPrompt, maxRetries = 2, ...produceOptions } = options;

  const produced = await run(produceOptions);

  if (!produced.resume) {
    throw new Error(
      "Cannot extract structured output: the producing run captured no resumable session.",
    );
  }

  const extracted = await produced.resume(extractionPrompt, {
    name: produceOptions.name ? `${produceOptions.name} (extract)` : undefined,
    output: { ...output, maxRetries },
  });

  // `commits` belongs to the producing run; the extraction pass makes none.
  return {
    ...extracted,
    commits: produced.commits,
    output: (extracted as RunResult & { output: T }).output,
  };
}
