// The runner against a fake Paseo API: send to an idle agent, queue for a
// busy one, flush when the turn ends, start an agent when there is none, and
// refuse an agent without docket's skills.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Runner } from "../server/runner.ts";

interface FakeAgent {
  id: string;
  provider: string;
  workspaceId: string;
  status: string;
  title: string | null;
  model: string | null;
  createdAt: string;
  updatedAt: string;
  lastUserMessageAt: string | null;
  archivedAt?: string | null;
  persistence: null;
}

function fake(agents: FakeAgent[], commands: string[] = ["docket:apply", "docket:start"]) {
  const sent: { id: string; text: string }[] = [];
  const created: { workspaceId: string; prompt?: string }[] = [];
  const paseo = {
    agents: {
      list: async () => ({ entries: agents.map((agent) => ({ agent })) }),
      ref: (id: string) => ({
        send: async (text: string) => {
          const agent = agents.find((a) => a.id === id)!;
          if (agent.status === "running") throw new Error("A foreground turn is already active");
          sent.push({ id, text });
          agent.status = "running";
        },
        refresh: async () => ({ agent: agents.find((a) => a.id === id)!, project: null }),
        commands: async () => ({ agentId: id, commands: commands.map((name) => ({ name, description: "", argumentHint: "" })), error: null, requestId: "r" }),
      }),
    },
    workspaces: {
      ref: (workspaceId: string) => ({
        agents: {
          create: async (options: { prompt?: string }) => {
            created.push({ workspaceId, prompt: options.prompt });
            return { id: "new-agent" };
          },
        },
      }),
    },
  };
  return { runner: new Runner(paseo as never), sent, created };
}

const agent = (id: string, status: string, at: string, extra: Partial<FakeAgent> = {}): FakeAgent => ({
  id, provider: "claude", workspaceId: "ws1", status, title: id, model: null,
  createdAt: at, updatedAt: at, lastUserMessageAt: at, persistence: null, ...extra,
});

const APPLY = { command: "docket:apply", args: "", prompt: "/docket:apply" };
const INGEST = { command: "docket:ingest", args: "", prompt: "/docket:ingest" };

test("sends to the most recently used idle Claude agent in the workspace", async () => {
  const { runner, sent } = fake([
    agent("old", "idle", "2026-10-01T00:00:00Z"),
    agent("recent", "idle", "2026-10-05T00:00:00Z"),
    agent("codex", "idle", "2026-10-06T00:00:00Z", { provider: "codex" }),
    agent("elsewhere", "idle", "2026-10-07T00:00:00Z", { workspaceId: "ws2" }),
  ]);
  const result = await runner.run("ws1", "/repo", APPLY);
  assert.equal(result.status, "sent");
  assert.deepEqual(sent, [{ id: "recent", text: "/docket:apply" }]);
});

test("queues while the agent works, then sends one prompt per finished turn", async () => {
  const agents = [agent("a", "running", "2026-10-05T00:00:00Z")];
  const { runner, sent } = fake(agents);
  assert.equal((await runner.run("ws1", "/repo", APPLY)).status, "queued");
  assert.equal((await runner.run("ws1", "/repo", INGEST)).status, "queued");
  assert.equal((await runner.run("ws1", "/repo", APPLY)).status, "queued", "a duplicate prompt queues once");
  assert.deepEqual((await runner.describe("ws1")).pending.map((p) => p.prompt), ["/docket:apply", "/docket:ingest"]);

  await runner.flush("a");
  assert.equal(sent.length, 0, "nothing goes out while the turn runs");

  agents[0].status = "idle";
  await runner.flush("a");
  assert.deepEqual(sent.map((s) => s.text), ["/docket:apply"]);
  agents[0].status = "idle";
  await runner.flushAll();
  assert.deepEqual(sent.map((s) => s.text), ["/docket:apply", "/docket:ingest"]);
  assert.deepEqual((await runner.describe("ws1")).pending, []);
});

test("cancel drops the workspace's waiting prompts", async () => {
  const { runner } = fake([agent("a", "running", "2026-10-05T00:00:00Z")]);
  await runner.run("ws1", "/repo", APPLY);
  assert.equal(runner.cancel("ws1"), 1);
  assert.deepEqual((await runner.describe("ws1")).pending, []);
});

test("an explicit target wins over the most recent agent", async () => {
  const { runner, sent } = fake([agent("chosen", "idle", "2026-10-01T00:00:00Z"), agent("recent", "idle", "2026-10-05T00:00:00Z")]);
  runner.setTarget("ws1", "chosen");
  await runner.run("ws1", "/repo", APPLY);
  assert.equal(sent[0].id, "chosen");
  assert.equal((await runner.describe("ws1")).targetId, "chosen");
});

test("starts a Claude agent with the prompt when the workspace has none", async () => {
  const { runner, created } = fake([agent("archived", "idle", "2026-10-05T00:00:00Z", { archivedAt: "2026-10-05T01:00:00Z" })]);
  const result = await runner.run("ws1", "/repo", APPLY);
  assert.equal(result.status, "created");
  assert.deepEqual(created, [{ workspaceId: "ws1", prompt: "/docket:apply" }]);
});

test("refuses an agent that loaded no docket skills", async () => {
  const { runner, sent } = fake([agent("a", "idle", "2026-10-05T00:00:00Z")], ["compact", "review"]);
  const result = await runner.run("ws1", "/repo", APPLY);
  assert.equal(result.status, "failed");
  assert.match(result.message, /no docket skills/);
  assert.equal(sent.length, 0);
});
