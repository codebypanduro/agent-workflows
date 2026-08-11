import { describe, expect, it } from "vitest";
import {
  filterInlineComments,
  parseDiffLines,
  reviewOutputSchema,
  summaryWithDropped,
  type InlineComment,
} from "./review-output.ts";

const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 export { a, b };
diff --git a/src/b.ts b/src/b.ts
new file mode 100644
--- /dev/null
+++ b/src/b.ts
@@ -0,0 +1,2 @@
+export const x = 1;
+export const y = 2;
`;

const comment = (path: string, line: number): InlineComment => ({
  path,
  line,
  body: "no",
});

describe("parseDiffLines", () => {
  it("maps post-image line numbers per file", () => {
    const lines = parseDiffLines(DIFF);

    // Context line 1, then +b at 2, +c at 3, then context at 4.
    expect([...(lines.get("src/a.ts") ?? [])]).toEqual([1, 2, 3, 4]);
    expect([...(lines.get("src/b.ts") ?? [])]).toEqual([1, 2]);
  });

  it("does not advance the cursor on removed lines", () => {
    // `const b = 2;` was removed and must not occupy a right-hand line number.
    expect(parseDiffLines(DIFF).get("src/a.ts")?.has(5)).toBe(false);
  });

  it("returns nothing for an empty diff", () => {
    expect(parseDiffLines("").size).toBe(0);
  });
});

describe("filterInlineComments", () => {
  const diff = parseDiffLines(DIFF);

  it("keeps a comment anchored inside the diff", () => {
    expect(filterInlineComments([comment("src/a.ts", 2)], diff).valid).toHaveLength(1);
  });

  // Each of these would 422 the whole review request, not just the comment.
  it("drops a comment on a file outside the diff", () => {
    const filtered = filterInlineComments([comment("src/never.ts", 1)], diff);

    expect(filtered.valid).toHaveLength(0);
    expect(filtered.dropped[0]?.reason).toBe("file is not in the diff");
  });

  it("drops a comment on a line outside the diff", () => {
    const filtered = filterInlineComments([comment("src/a.ts", 99)], diff);

    expect(filtered.valid).toHaveLength(0);
    expect(filtered.dropped[0]?.reason).toContain("line 99");
  });

  it("keeps the good comments when only some are bad", () => {
    const filtered = filterInlineComments(
      [comment("src/a.ts", 2), comment("src/a.ts", 99), comment("src/b.ts", 1)],
      diff,
    );

    expect(filtered.valid).toHaveLength(2);
    expect(filtered.dropped).toHaveLength(1);
  });
});

describe("summaryWithDropped", () => {
  it("leaves a clean summary alone", () => {
    expect(summaryWithDropped("Looks fine.", [])).toBe("Looks fine.");
  });

  // A finding worth making does not disappear because its line number was wrong.
  it("folds dropped findings into the body rather than losing them", () => {
    const merged = summaryWithDropped("Looks fine.", [
      { comment: comment("src/a.ts", 99), reason: "line 99 is not in the diff" },
    ]);

    expect(merged).toContain("Looks fine.");
    expect(merged).toContain("`src/a.ts:99`");
    expect(merged).toContain("no");
  });
});

describe("reviewOutputSchema", () => {
  it("defaults inlineComments so a review with none still parses", () => {
    const parsed = reviewOutputSchema.parse({ summary: "Fine.", blocking: false });

    expect(parsed.inlineComments).toEqual([]);
  });

  it("rejects a non-positive line, which GitHub would reject anyway", () => {
    const result = reviewOutputSchema.safeParse({
      summary: "x",
      blocking: true,
      inlineComments: [{ path: "a.ts", line: 0, body: "b" }],
    });

    expect(result.success).toBe(false);
  });

  it("rejects an empty summary — the review body cannot be blank", () => {
    expect(reviewOutputSchema.safeParse({ summary: "", blocking: false }).success).toBe(false);
  });
});
