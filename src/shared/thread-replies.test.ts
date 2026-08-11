import { describe, expect, it } from "vitest";
import { parseAgentReplies, planReplies } from "./thread-replies.ts";

const RUN_URL = "https://github.com/x/y/actions/runs/1";
const threads = [{ id: "T_1" }, { id: "T_2" }];

describe("parseAgentReplies", () => {
  it("takes well-formed replies", () => {
    expect(parseAgentReplies('[{"threadId":"T_1","body":"Fixed."}]')).toEqual([
      { threadId: "T_1", body: "Fixed." },
    ]);
  });

  // Losing a whole run because one array element lacked a body would be a bad
  // trade — the fallback covers whatever is dropped here.
  it("drops malformed entries instead of throwing", () => {
    const parsed = parseAgentReplies(
      '[{"threadId":"T_1","body":"Fixed."},{"threadId":"T_2"},null,{"body":"orphan"},{"threadId":"T_3","body":"  "}]',
    );

    expect(parsed).toEqual([{ threadId: "T_1", body: "Fixed." }]);
  });

  it("returns nothing for a non-array", () => {
    expect(parseAgentReplies('{"threadId":"T_1"}')).toEqual([]);
  });

  it("throws only on invalid JSON, which the caller catches", () => {
    expect(() => parseAgentReplies("not json")).toThrow();
  });
});

describe("planReplies", () => {
  it("uses the agent's own words when it wrote some", () => {
    const planned = planReplies(threads, [{ threadId: "T_1", body: "Fixed in abc123." }], RUN_URL);

    expect(planned[0]).toEqual({ threadId: "T_1", body: "Fixed in abc123.", authored: true });
  });

  // This is the dedup marker. A thread with no reply comes back as outstanding
  // work on every future run, forever.
  it("still replies to a thread the agent ignored", () => {
    const planned = planReplies(threads, [{ threadId: "T_1", body: "Fixed." }], RUN_URL);

    expect(planned).toHaveLength(2);
    expect(planned[1]?.authored).toBe(false);
    expect(planned[1]?.body).toContain(RUN_URL);
  });

  it("replies to every thread when the agent wrote nothing at all", () => {
    const planned = planReplies(threads, [], RUN_URL);

    expect(planned.map((reply) => reply.threadId)).toEqual(["T_1", "T_2"]);
    expect(planned.every((reply) => !reply.authored)).toBe(true);
  });

  it("ignores replies to threads that were not in scope", () => {
    const planned = planReplies([{ id: "T_1" }], [{ threadId: "T_9", body: "stray" }], RUN_URL);

    expect(planned).toHaveLength(1);
    expect(planned[0]?.authored).toBe(false);
  });
});
