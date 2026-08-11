import { describe, expect, it } from "vitest";
import {
  isAnsweredByAgent,
  parsePullRequest,
  renderWork,
  selectWork,
  type PullRequest,
  type ReviewThread,
} from "./pr-context.ts";

const AGENT = "tvoverblik-agent";

const thread = (over: Partial<ReviewThread> = {}): ReviewThread => ({
  id: "T_1",
  isResolved: false,
  isOutdated: false,
  path: "a.ts",
  line: 4,
  comments: [{ id: "C_1", author: "casperpanduro", body: "This leaks.", createdAt: "2026-08-01T00:00:00Z" }],
  ...over,
});

const pr = (over: Partial<PullRequest> = {}): PullRequest => ({
  number: 144,
  title: "Fix the thing",
  body: "Closes #141",
  headRefName: "agent/issue-141",
  baseRefName: "main",
  isDraft: false,
  threads: [],
  comments: [],
  ...over,
});

describe("parsePullRequest", () => {
  const raw = JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          number: 144,
          title: "Fix the thing",
          body: "Closes #141",
          isDraft: true,
          headRefName: "agent/issue-141",
          baseRefName: "main",
          reviewThreads: {
            nodes: [
              {
                id: "T_1",
                isResolved: false,
                isOutdated: false,
                path: "a.ts",
                line: 4,
                comments: {
                  nodes: [
                    { id: "C_1", author: { login: "casperpanduro" }, body: "This leaks.", createdAt: "2026-08-01T00:00:00Z" },
                  ],
                },
              },
            ],
          },
          comments: {
            nodes: [{ author: { login: "casperpanduro" }, body: "Also, rename it.", createdAt: "2026-08-02T00:00:00Z" }],
          },
          commits: {
            nodes: [
              { commit: { messageHeadline: "agent: first pass", committedDate: "2026-08-01T12:00:00Z" } },
              { commit: { messageHeadline: "chore: not the agent", committedDate: "2026-08-03T00:00:00Z" } },
              { commit: { messageHeadline: "agent: second pass", committedDate: "2026-08-01T18:00:00Z" } },
            ],
          },
        },
      },
    },
  });

  it("shapes the response", () => {
    const parsed = parsePullRequest(raw);

    expect(parsed.number).toBe(144);
    expect(parsed.headRefName).toBe("agent/issue-141");
    expect(parsed.threads).toHaveLength(1);
    expect(parsed.threads[0]?.comments[0]?.author).toBe("casperpanduro");
    expect(parsed.comments).toHaveLength(1);
  });

  it("takes the latest agent commit, ignoring commit order and other authors", () => {
    expect(parsePullRequest(raw).lastAgentCommitAt).toBe("2026-08-01T18:00:00Z");
  });

  it("survives a deleted comment author", () => {
    const ghost = JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            number: 1,
            comments: { nodes: [{ author: null, body: "hi", createdAt: "2026-01-01T00:00:00Z" }] },
          },
        },
      },
    });

    expect(parsePullRequest(ghost).comments[0]?.author).toBe("unknown");
  });

  it("throws rather than silently reviewing nothing", () => {
    expect(() => parsePullRequest(JSON.stringify({ data: { repository: null } }))).toThrow(
      /no pull request/,
    );
  });
});

describe("selectWork", () => {
  it("takes an unresolved, unanswered thread", () => {
    expect(selectWork(pr({ threads: [thread()] }), AGENT).threads).toHaveLength(1);
  });

  it("leaves resolved and outdated threads alone", () => {
    const threads = [thread({ id: "a", isResolved: true }), thread({ id: "b", isOutdated: true })];

    expect(selectWork(pr({ threads }), AGENT).threads).toHaveLength(0);
  });

  // The dedup marker. Without this the same feedback is worked forever.
  it("skips a thread the agent already replied to", () => {
    const answered = thread({
      comments: [
        { id: "C_1", author: "casperpanduro", body: "This leaks.", createdAt: "2026-08-01T00:00:00Z" },
        { id: "C_2", author: AGENT, body: "Fixed in abc123.", createdAt: "2026-08-01T01:00:00Z" },
      ],
    });

    expect(selectWork(pr({ threads: [answered] }), AGENT).threads).toHaveLength(0);
  });

  // ...but a human getting the last word puts it back in scope, which is what
  // you want when the fix was wrong.
  it("takes the thread back when a human replies after the agent", () => {
    const reopened = thread({
      comments: [
        { id: "C_1", author: "casperpanduro", body: "This leaks.", createdAt: "2026-08-01T00:00:00Z" },
        { id: "C_2", author: AGENT, body: "Fixed in abc123.", createdAt: "2026-08-01T01:00:00Z" },
        { id: "C_3", author: "casperpanduro", body: "No it isn't.", createdAt: "2026-08-01T02:00:00Z" },
      ],
    });

    expect(selectWork(pr({ threads: [reopened] }), AGENT).threads).toHaveLength(1);
  });

  it("takes only the comments made since the agent last committed", () => {
    const subject = pr({
      lastAgentCommitAt: "2026-08-02T00:00:00Z",
      comments: [
        { author: "casperpanduro", body: "old", createdAt: "2026-08-01T00:00:00Z" },
        { author: "casperpanduro", body: "new", createdAt: "2026-08-03T00:00:00Z" },
      ],
    });

    expect(selectWork(subject, AGENT).comments.map((c) => c.body)).toEqual(["new"]);
  });

  it("takes every comment when the agent has never committed", () => {
    const subject = pr({
      comments: [{ author: "casperpanduro", body: "do this", createdAt: "2026-08-01T00:00:00Z" }],
    });

    expect(selectWork(subject, AGENT).comments).toHaveLength(1);
  });

  it("never treats the agent's own comments as instructions", () => {
    const subject = pr({
      comments: [{ author: AGENT, body: "I have done the thing", createdAt: "2026-08-09T00:00:00Z" }],
    });

    expect(selectWork(subject, AGENT).comments).toHaveLength(0);
  });
});

describe("isAnsweredByAgent", () => {
  it("looks only at the last comment", () => {
    expect(isAnsweredByAgent(thread(), AGENT)).toBe(false);
  });
});

describe("renderWork", () => {
  it("names the thread id, so the agent can address its reply", () => {
    const rendered = renderWork(selectWork(pr({ threads: [thread()] }), AGENT));

    expect(rendered).toContain("T_1");
    expect(rendered).toContain("`a.ts`:4");
    expect(rendered).toContain("This leaks.");
  });

  it("is empty when there is nothing to do, so the caller can refuse on it", () => {
    expect(renderWork(selectWork(pr(), AGENT))).toBe("");
  });
});
