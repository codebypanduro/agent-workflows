import { describe, expect, it } from "vitest";
import { census, compareCensus, isTestFile, type TestFile } from "./test-guard.ts";

const file = (path: string, contents: string): TestFile => ({ path, contents });

const suite = (cases: number, path = "a.test.ts"): TestFile[] => [
  file(
    path,
    Array.from({ length: cases }, (_, i) => `it("case ${i}", () => { expect(1).toBe(1); });`).join(
      "\n",
    ),
  ),
];

const compare = (before: TestFile[], after: TestFile[]) =>
  compareCensus(census(before), census(after));

describe("isTestFile", () => {
  it("recognises the suffixes this repo uses", () => {
    expect(isTestFile("a.test.ts")).toBe(true);
    expect(isTestFile("a.spec.tsx")).toBe(true);
    expect(isTestFile("lifecycle.test.ts")).toBe(true);
    expect(isTestFile("apps/web/lib/__tests__/x.test.ts")).toBe(true);
  });

  it("ignores everything else", () => {
    expect(isTestFile("index.ts")).toBe(false);
    expect(isTestFile("testing.ts")).toBe(false);
    expect(isTestFile("a.test.md")).toBe(false);
  });
});

describe("what the guard allows", () => {
  it("an unchanged suite", () => {
    expect(compare(suite(3), suite(3)).tripped).toBe(false);
  });

  it("added tests — the whole point of a retry is often more coverage", () => {
    expect(compare(suite(3), suite(5)).tripped).toBe(false);
  });

  it("a rewritten case, as long as the count holds", () => {
    const before = [file("a.test.ts", `it("old", () => {});`)];
    const after = [file("a.test.ts", `it("new and better", () => { expect(2).toBe(2); });`)];

    expect(compare(before, after).tripped).toBe(false);
  });

  it("a renamed file carrying the same cases", () => {
    expect(compare(suite(4, "old.test.ts"), suite(4, "new.test.ts")).tripped).toBe(false);
  });

  it("a brand new test file", () => {
    expect(compare([], suite(2)).tripped).toBe(false);
  });

  it("changes to files that are not tests", () => {
    const before = [file("index.ts", "export const a = 1;")];
    const after: TestFile[] = [];

    expect(compare(before, after).tripped).toBe(false);
  });
});

describe("what the guard catches", () => {
  it("a deleted test file", () => {
    const verdict = compare(suite(3), []);

    expect(verdict.tripped).toBe(true);
    expect(verdict.detail).toContain("`a.test.ts` was deleted");
  });

  it("cases removed from a file that survives", () => {
    const verdict = compare(suite(5), suite(2));

    expect(verdict.tripped).toBe(true);
    expect(verdict.detail).toContain("lost 3 test case(s)");
  });

  // The move this guard exists for: the case stays in the file, and leaves the
  // suite. Counting lines or diffing text would both miss it.
  it("a case turned into it.skip", () => {
    const before = [file("a.test.ts", `it("x", () => {});\nit("y", () => {});`)];
    const after = [file("a.test.ts", `it("x", () => {});\nit.skip("y", () => {});`)];
    const verdict = compare(before, after);

    expect(verdict.tripped).toBe(true);
    expect(verdict.detail).toContain("skipped or marked todo");
  });

  it("a case turned into it.todo", () => {
    const before = [file("a.test.ts", `it("x", () => {});`)];
    const after = [file("a.test.ts", `it.todo("x");`)];

    expect(compare(before, after).tripped).toBe(true);
  });

  it("a whole describe block skipped", () => {
    const before = [file("a.test.ts", `describe("x", () => { it("y", () => {}); });`)];
    const after = [file("a.test.ts", `describe.skip("x", () => { it("y", () => {}); });`)];

    expect(compare(before, after).tripped).toBe(true);
  });

  it("a rename that quietly drops cases on the way", () => {
    const verdict = compare(suite(6, "old.test.ts"), suite(2, "new.test.ts"));

    expect(verdict.tripped).toBe(true);
    expect(verdict.detail).toContain("`old.test.ts` was deleted");
  });

  it("reports every file it is unhappy about, not just the first", () => {
    const before = [...suite(3, "a.test.ts"), ...suite(3, "b.test.ts")];
    const after = [...suite(1, "a.test.ts"), ...suite(1, "b.test.ts")];
    const verdict = compare(before, after);

    expect(verdict.detail).toContain("a.test.ts");
    expect(verdict.detail).toContain("b.test.ts");
  });
});

describe("counting", () => {
  it("counts it, test and it.each as cases", () => {
    const counted = census([
      file(
        "a.test.ts",
        `it("a", () => {});\ntest("b", () => {});\nit.each([1, 2])("c %i", () => {});`,
      ),
    ]);

    expect(counted.cases.get("a.test.ts")).toBe(3);
  });

  it("does not count prose that happens to mention it(", () => {
    const counted = census([
      file("a.test.ts", `// call it(name, fn) to add a case\nit("real", () => {});`),
    ]);

    expect(counted.cases.get("a.test.ts")).toBe(1);
  });

  it("does not count a method call that ends in it(", () => {
    const counted = census([file("a.test.ts", `wait();\nawait submit();\nit("real", () => {});`)]);

    expect(counted.cases.get("a.test.ts")).toBe(1);
  });
});
