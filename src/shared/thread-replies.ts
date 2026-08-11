// Deciding what the agent replies to each review thread.
//
// A reply is not courtesy — it is the dedup marker. A thread the agent silently
// skipped stays unanswered, so the next run picks it up as outstanding work and
// fixes it again. Every selected thread therefore gets a reply, with the
// agent's own words when it wrote some and a templated acknowledgement when it
// did not.
//
// Pure, so the fallback behaviour is testable without a pull request.

export interface AgentReply {
  readonly threadId: string;
  readonly body: string;
}

export interface PlannedReply {
  readonly threadId: string;
  readonly body: string;
  /** True when the agent wrote this itself, false when it was templated in. */
  readonly authored: boolean;
}

/**
 * Parses what the agent wrote, tolerating everything except invalid JSON.
 *
 * Unknown thread ids and malformed entries are dropped rather than throwing:
 * the fallback covers whatever is missing, and losing a whole run because one
 * array element lacked a `body` would be a bad trade.
 */
export function parseAgentReplies(raw: string): AgentReply[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) return [];

  const replies: AgentReply[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const { threadId, body } = entry as { threadId?: unknown; body?: unknown };
    if (typeof threadId !== "string" || typeof body !== "string") continue;
    if (threadId.trim() === "" || body.trim() === "") continue;
    replies.push({ threadId, body });
  }
  return replies;
}

const fallback = (runUrl: string): string =>
  `The agent read this thread in [its last run](${runUrl}) but did not write a reply for it. Check the commits on this branch to see whether it acted on this — and say more here if it missed the point.`;

export function planReplies(
  threads: readonly { readonly id: string }[],
  authored: readonly AgentReply[],
  runUrl: string,
): PlannedReply[] {
  const byThread = new Map(authored.map((reply) => [reply.threadId, reply.body]));

  return threads.map((thread) => {
    const body = byThread.get(thread.id);
    return body
      ? { threadId: thread.id, body, authored: true }
      : { threadId: thread.id, body: fallback(runUrl), authored: false };
  });
}
