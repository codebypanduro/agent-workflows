// What a pull request currently has to say, and which of it is still the
// agent's problem.
//
// The parsing and selection here are pure and unit tested. `fetchPullRequest`
// is the one function that touches `gh`; everything it feeds is data.
//
// Resolved state lives only in GraphQL — `gh pr view --json comments` cannot
// see it — so the query below is not an optimisation, it is the only way to
// ask the question.

import { gh } from "./common.ts";

export interface ThreadComment {
  readonly id: string;
  readonly author: string;
  readonly body: string;
  readonly createdAt: string;
}

export interface ReviewThread {
  readonly id: string;
  readonly isResolved: boolean;
  readonly isOutdated: boolean;
  readonly path?: string;
  readonly line?: number;
  readonly comments: readonly ThreadComment[];
}

export interface IssueComment {
  readonly author: string;
  readonly body: string;
  readonly createdAt: string;
}

export interface PullRequest {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly headRefName: string;
  readonly baseRefName: string;
  readonly isDraft: boolean;
  readonly threads: readonly ReviewThread[];
  readonly comments: readonly IssueComment[];
  /** When the agent last committed, or `undefined` if it never has. */
  readonly lastAgentCommitAt?: string;
}

const QUERY = `
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      number
      title
      body
      isDraft
      headRefName
      baseRefName
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          comments(first: 50) {
            nodes { id author { login } body createdAt }
          }
        }
      }
      comments(first: 100) {
        nodes { author { login } body createdAt }
      }
      commits(last: 100) {
        nodes { commit { messageHeadline committedDate } }
      }
    }
  }
}`;

interface RawNode {
  readonly [key: string]: unknown;
}

const asArray = (value: unknown): RawNode[] =>
  Array.isArray(value) ? (value as RawNode[]) : [];

const login = (value: unknown): string => {
  const author = value as { login?: unknown } | null;
  return typeof author?.login === "string" ? author.login : "unknown";
};

/** Shapes the GraphQL response. Separate from the fetch so it can be tested. */
export function parsePullRequest(raw: string, commitPrefix = "agent:"): PullRequest {
  const parsed = JSON.parse(raw) as {
    data?: { repository?: { pullRequest?: RawNode | null } | null };
  };
  const pr = parsed.data?.repository?.pullRequest;
  if (!pr) throw new Error("The GraphQL response contained no pull request.");

  const threadNodes = asArray((pr.reviewThreads as RawNode | undefined)?.nodes);
  const threads: ReviewThread[] = threadNodes.map((thread) => ({
    id: String(thread.id),
    isResolved: Boolean(thread.isResolved),
    isOutdated: Boolean(thread.isOutdated),
    path: typeof thread.path === "string" ? thread.path : undefined,
    line: typeof thread.line === "number" ? thread.line : undefined,
    comments: asArray((thread.comments as RawNode | undefined)?.nodes).map((comment) => ({
      id: String(comment.id),
      author: login(comment.author),
      body: String(comment.body ?? ""),
      createdAt: String(comment.createdAt ?? ""),
    })),
  }));

  const comments: IssueComment[] = asArray((pr.comments as RawNode | undefined)?.nodes).map(
    (comment) => ({
      author: login(comment.author),
      body: String(comment.body ?? ""),
      createdAt: String(comment.createdAt ?? ""),
    }),
  );

  const agentCommits = asArray((pr.commits as RawNode | undefined)?.nodes)
    .map((node) => node.commit as RawNode | undefined)
    .filter((commit): commit is RawNode => Boolean(commit))
    .filter((commit) => String(commit.messageHeadline ?? "").startsWith(commitPrefix))
    .map((commit) => String(commit.committedDate ?? ""))
    .filter(Boolean)
    .sort();

  return {
    number: Number(pr.number),
    title: String(pr.title ?? ""),
    body: String(pr.body ?? ""),
    headRefName: String(pr.headRefName ?? ""),
    baseRefName: String(pr.baseRefName ?? ""),
    isDraft: Boolean(pr.isDraft),
    threads,
    comments,
    lastAgentCommitAt: agentCommits.at(-1),
  };
}

export function fetchPullRequest(repo: string, number: string, commitPrefix = "agent:"): PullRequest {
  const [owner, name] = repo.split("/");
  if (!owner || !name) throw new Error(`REPO must be owner/name, got: ${repo}`);

  return parsePullRequest(
    gh([
      "api",
      "graphql",
      "-f",
      `query=${QUERY}`,
      "-f",
      `owner=${owner}`,
      "-f",
      `repo=${name}`,
      "-F",
      `number=${number}`,
    ]),
    commitPrefix,
  );
}

/**
 * Whether the agent has already answered a thread.
 *
 * This is the dedup marker. The alternative — resolving the thread — would have
 * an agent closing out a human's feedback, so the reply itself carries the
 * state instead. It also means a human replying *after* the agent puts the
 * thread straight back in scope, which is the behaviour you want when the fix
 * was wrong.
 */
export function isAnsweredByAgent(thread: ReviewThread, agentLogin: string): boolean {
  return thread.comments.at(-1)?.author === agentLogin;
}

export interface PullRequestWork {
  /** Threads the agent should act on. */
  readonly threads: readonly ReviewThread[];
  /** Top-level comments added since the agent last committed. */
  readonly comments: readonly IssueComment[];
}

/**
 * What is left for the agent to do on this pull request.
 *
 * Threads are unresolved, not outdated, and not already answered by the agent.
 * Top-level comments are everyone else's, since the agent's last commit — that
 * is the instruction channel, so "actually, just do X" lands there and is read.
 */
export function selectWork(pr: PullRequest, agentLogin: string): PullRequestWork {
  const threads = pr.threads.filter(
    (thread) =>
      !thread.isResolved && !thread.isOutdated && !isAnsweredByAgent(thread, agentLogin),
  );

  const since = pr.lastAgentCommitAt;
  const comments = pr.comments.filter(
    (comment) => comment.author !== agentLogin && (!since || comment.createdAt > since),
  );

  return { threads, comments };
}

/** Renders the selected work for a prompt. */
export function renderWork(work: PullRequestWork): string {
  const blocks: string[] = [];

  if (work.threads.length > 0) {
    blocks.push("### Unresolved review threads\n");
    for (const thread of work.threads) {
      const where = thread.path
        ? `\`${thread.path}\`${thread.line ? `:${thread.line}` : ""}`
        : "(no file)";
      const conversation = thread.comments
        .map((comment) => `  **${comment.author}**: ${comment.body}`)
        .join("\n\n");
      blocks.push(`- Thread \`${thread.id}\` on ${where}\n\n${conversation}\n`);
    }
  }

  if (work.comments.length > 0) {
    blocks.push("### Comments since your last commit\n");
    for (const comment of work.comments) {
      blocks.push(`- **${comment.author}**: ${comment.body}\n`);
    }
  }

  return blocks.join("\n");
}

/**
 * The login whose replies mean "already handled".
 *
 * Defaults to the repository owner, which is right whenever the PAT belongs to
 * you — the common case. Projects where the agent posts as a bot set it.
 */
export function agentLoginFor(config: { agentLogin?: string }, repo: string): string {
  if (config.agentLogin) return config.agentLogin;
  const owner = repo.split("/")[0];
  if (!owner) throw new Error(`REPO must be owner/name, got: ${repo}`);
  return owner;
}
