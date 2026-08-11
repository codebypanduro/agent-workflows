// The test-deletion guard (docs/adr/0008).
//
// The self-repair loop hands a failing agent the same instruction three times:
// make the red go away. An agent that cannot fix the bug still has one move
// that always works — delete the assertion, skip the case, drop the file. That
// run then passes verification, passes `test.yml`, and reaches a comment-only
// reviewer as the last line of defence.
//
// So the loop does not trust green on its own. Between laps it counts the test
// cases on the branch; if a lap removed or skipped any, the run is stopped
// whatever verification says.
//
// Counting cases rather than diffing text is deliberate: the agent is *supposed*
// to edit tests while fixing things, and a guard that fires on every legitimate
// edit is a guard someone turns off.

/** Files whose contents this guard counts. */
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

/**
 * Test-case openers, counted per file.
 *
 * Matches `it(`, `test(`, `it.each(...)`, `describe(` and friends at a call
 * position, so a string mentioning "it(" in prose does not register. Skipped
 * forms are counted separately rather than ignored — turning `it` into `it.skip`
 * keeps the case in the file and takes it out of the suite, which is exactly
 * the move this guard exists to catch.
 */
const CASE = /(?<![\w$.])(?:it|test)(?:\.each\([^)]*\))?\s*(?:\.\s*(?:concurrent|extend|for|sequential|each))*\s*\(/g;
const SKIPPED = /(?<![\w$.])(?:it|test|describe)\s*\.\s*(?:skip|todo|failing)\b/g;

export interface TestFile {
  readonly path: string;
  readonly contents: string;
}

export interface TestCensus {
  /** Live test cases per file. */
  readonly cases: ReadonlyMap<string, number>;
  /** Explicitly skipped or todo'd cases per file. */
  readonly skipped: ReadonlyMap<string, number>;
}

/**
 * Comments, which are counted by nobody.
 *
 * Without this, a line like `// call it(name, fn) to add a case` registers as a
 * test — and worse, deleting that comment would register as deleting a test.
 * Crude by design: this only ever feeds a count, so a string literal containing
 * `//` costing one false negative is a far better trade than parsing TypeScript.
 */
const COMMENT = /\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;

function count(pattern: RegExp, contents: string): number {
  const code = contents.replace(COMMENT, "");
  // Fresh lastIndex each call — these are module-level /g regexes.
  pattern.lastIndex = 0;
  let total = 0;
  while (pattern.exec(code) !== null) total += 1;
  return total;
}

export function isTestFile(path: string): boolean {
  return TEST_FILE.test(path);
}

/** Counts the test cases in every test file it is given. */
export function census(files: readonly TestFile[]): TestCensus {
  const cases = new Map<string, number>();
  const skipped = new Map<string, number>();

  for (const file of files) {
    if (!isTestFile(file.path)) continue;
    cases.set(file.path, count(CASE, file.contents));
    skipped.set(file.path, count(SKIPPED, file.contents));
  }

  return { cases, skipped };
}

export interface GuardVerdict {
  /** True when the lap removed or disabled test coverage. */
  readonly tripped: boolean;
  /** Human-readable, and it goes straight into the `human:blocked` comment. */
  readonly detail: string;
}

const PASSED: GuardVerdict = { tripped: false, detail: "" };

/**
 * Compares two censuses taken either side of one retry lap.
 *
 * Adding tests, renaming a file, or rewriting a case in place are all allowed.
 * Removing a file, removing cases from a file, or converting a case to
 * `.skip`/`.todo`/`.failing` are not.
 */
export function compareCensus(before: TestCensus, after: TestCensus): GuardVerdict {
  const complaints: string[] = [];

  for (const [path, hadCases] of before.cases) {
    const nowCases = after.cases.get(path);

    if (nowCases === undefined) {
      // A rename shows up as a deletion plus an addition. Treat a new file
      // carrying at least as many cases as cover for the old one, so tidying
      // file names does not read as sabotage.
      const rehomed = [...after.cases].some(
        ([candidate, candidateCases]) =>
          !before.cases.has(candidate) && candidateCases >= hadCases,
      );
      if (!rehomed) complaints.push(`\`${path}\` was deleted (${hadCases} test case(s)).`);
      continue;
    }

    if (nowCases < hadCases) {
      complaints.push(
        `\`${path}\` lost ${hadCases - nowCases} test case(s) (${hadCases} → ${nowCases}).`,
      );
    }

    const hadSkipped = before.skipped.get(path) ?? 0;
    const nowSkipped = after.skipped.get(path) ?? 0;
    if (nowSkipped > hadSkipped) {
      complaints.push(
        `\`${path}\` had ${nowSkipped - hadSkipped} test case(s) skipped or marked todo.`,
      );
    }
  }

  if (complaints.length === 0) return PASSED;
  return { tripped: true, detail: complaints.join(" ") };
}
