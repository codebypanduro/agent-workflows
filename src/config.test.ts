import { describe, expect, it } from "vitest";
import { branchFor, configSchema, ConfigError, parseConfig } from "./config.ts";

const minimal = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ verify: ["npm test"], ...over });

describe("parseConfig", () => {
  it("fills in every default from the one required field", () => {
    const config = parseConfig(minimal());

    expect(config.setup).toEqual(["npm ci"]);
    expect(config.model).toBe("claude-opus-5");
    expect(config.maxRetries).toBe(2);
    expect(config.commitPrefix).toBe("agent:");
    expect(config.branchPattern).toBe("agent/issue-{issue}");
    expect(config.env).toEqual({});
  });

  // Deliberately has no default: a guessed verify command means an agent can
  // pass something the pull request would fail.
  it("refuses a config with no verify commands", () => {
    expect(() => parseConfig(JSON.stringify({ setup: ["npm ci"] }))).toThrow(ConfigError);
    expect(() => parseConfig(JSON.stringify({ verify: [] }))).toThrow(ConfigError);
  });

  it("names the offending field so the log is actionable", () => {
    let message = "";
    try {
      parseConfig(minimal({ maxRetries: 99 }), "my.json");
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain("my.json");
    expect(message).toContain("maxRetries");
  });

  it("reports invalid JSON as such rather than as a schema failure", () => {
    expect(() => parseConfig("{ nope", "broken.json")).toThrow(/broken\.json is not valid JSON/);
  });

  it("keeps what a project actually set", () => {
    const config = parseConfig(
      minimal({
        setup: ["pnpm i", "pnpm prisma generate"],
        env: { DATABASE_URL: "postgres://x" },
        git: { name: "acme agent", email: "dev@acme.com" },
        maxRetries: 0,
      }),
    );

    expect(config.setup).toEqual(["pnpm i", "pnpm prisma generate"]);
    expect(config.env.DATABASE_URL).toBe("postgres://x");
    expect(config.git.name).toBe("acme agent");
    expect(config.maxRetries).toBe(0);
  });

  it("allows disabling retries but has no way to disable the guard", () => {
    const config = parseConfig(minimal({ maxRetries: 0 }));

    expect(config.maxRetries).toBe(0);
    expect(Object.keys(configSchema.shape)).not.toContain("testGuard");
  });
});

describe("branchFor", () => {
  it("substitutes the issue number", () => {
    expect(branchFor(parseConfig(minimal()), 42)).toBe("agent/issue-42");
  });

  it("honours a project's own pattern", () => {
    const config = parseConfig(minimal({ branchPattern: "bot/{issue}-wip" }));

    expect(branchFor(config, "7")).toBe("bot/7-wip");
  });
});
