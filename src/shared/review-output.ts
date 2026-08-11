// The reviewer's structured output, and the validation that stops it from
// failing the whole step.
//
// GitHub rejects a review with 422 if any inline comment names a path/line that
// is not part of the diff — the whole request, not the offending comment. One
// hallucinated line number would therefore throw away an entire review. So
// every comment is checked against the diff before posting, and the ones that
// do not fit are dropped and reported rather than sent.

import { z } from "zod";

export const reviewOutputSchema = z.object({
  /** Posted as the review body. */
  summary: z.string().min(1),
  /**
   * Whether anything found here should be fixed before a human reads it.
   *
   * This is the flag that decides whether the chain continues to
   * implement-pr (docs/adr/0004), so it is deliberately the reviewer's own
   * judgement rather than something inferred from the comment count — a
   * review can raise three nits and still be fine to merge.
   */
  blocking: z.boolean(),
  inlineComments: z
    .array(
      z.object({
        path: z.string().min(1),
        line: z.number().int().positive(),
        body: z.string().min(1),
      }),
    )
    .default([]),
});

export type ReviewOutput = z.infer<typeof reviewOutputSchema>;
export type InlineComment = ReviewOutput["inlineComments"][number];

/** Right-hand-side line numbers that a review comment may attach to, per file. */
export type DiffLines = ReadonlyMap<string, ReadonlySet<number>>;

/**
 * Parses `git diff` hunk headers into the set of post-image lines per file.
 *
 * Only added and context lines are commentable on the RIGHT side; removed lines
 * exist only in the pre-image and GitHub will reject a comment on one.
 */
export function parseDiffLines(diff: string): DiffLines {
  const lines = new Map<string, Set<number>>();
  let current: Set<number> | undefined;
  let cursor = 0;

  for (const line of diff.split("\n")) {
    const file = /^\+\+\+ b\/(.+)$/.exec(line);
    if (file?.[1]) {
      current = new Set<number>();
      lines.set(file[1], current);
      continue;
    }

    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk?.[1]) {
      cursor = Number(hunk[1]);
      continue;
    }

    if (!current) continue;

    if (line.startsWith("+")) {
      current.add(cursor);
      cursor += 1;
    } else if (line.startsWith(" ")) {
      current.add(cursor);
      cursor += 1;
    }
    // "-" lines and everything else do not advance the post-image cursor.
  }

  return lines;
}

export interface FilteredComments {
  readonly valid: readonly InlineComment[];
  /** Dropped comments, with why — surfaced in the job summary, never silently lost. */
  readonly dropped: readonly { readonly comment: InlineComment; readonly reason: string }[];
}

export function filterInlineComments(
  comments: readonly InlineComment[],
  diff: DiffLines,
): FilteredComments {
  const valid: InlineComment[] = [];
  const dropped: { comment: InlineComment; reason: string }[] = [];

  for (const comment of comments) {
    const fileLines = diff.get(comment.path);
    if (!fileLines) {
      dropped.push({ comment, reason: "file is not in the diff" });
      continue;
    }
    if (!fileLines.has(comment.line)) {
      dropped.push({ comment, reason: `line ${comment.line} is not in the diff` });
      continue;
    }
    valid.push(comment);
  }

  return { valid, dropped };
}

/**
 * Folds dropped comments into the review body.
 *
 * A finding the reviewer considered worth making does not disappear because its
 * line number was wrong — it moves into the summary, where it costs a human one
 * extra scroll instead of being lost.
 */
export function summaryWithDropped(summary: string, dropped: FilteredComments["dropped"]): string {
  if (dropped.length === 0) return summary;

  const rows = dropped
    .map(({ comment, reason }) => `- \`${comment.path}:${comment.line}\` (${reason}) — ${comment.body}`)
    .join("\n");

  return `${summary}\n\n---\n\n**Comments that could not be anchored to the diff:**\n\n${rows}`;
}
