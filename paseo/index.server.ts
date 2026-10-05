// The Docket plugin's daemon side: docket reads and writes for the panel, and
// docket skills sent to the workspace's Claude agent.
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { callApi, callPlan, overviewOf } from "./server/api";
import { Runner } from "./server/runner";
import { docketAgents, docketApi, docketCancelPending, docketOverview, docketPlan, docketRun, docketSetTarget } from "./shared/rpc";

const FLUSH_MS = 5000;

/** The desktop app's daemon can start with a minimal PATH. docket needs git, and gh at start. */
function widenPath(): void {
  const extra = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
  const parts = (process.env.PATH ?? "").split(":").filter(Boolean);
  for (const dir of extra) if (!parts.includes(dir)) parts.push(dir);
  process.env.PATH = parts.join(":");
}

export default function contribute(server: PluginServerContext) {
  widenPath();
  let runner: Runner | null = null;
  const runnerFor = (paseo: ConstructorParameters<typeof Runner>[0]) => (runner ??= new Runner(paseo));

  server.handle(docketApi, ({ cwd, op, name, args }) => callApi(cwd, op, name, args));

  server.handle(docketOverview, ({ dirs }) => ({ items: dirs.map(overviewOf) }));

  server.handle(docketPlan, async ({ workspaceId, cwd, kind, args }, { paseo }) => {
    const run = runnerFor(paseo);
    const sessionId = await run.sessionIdOf(workspaceId).catch(() => undefined);
    const planned = callPlan(cwd, kind, { ...(args ?? {}), sessionId });
    if (!planned.ok) return { ok: false, error: planned.error };
    // quickFix decides first and returns { finding, plan }; the others return the plan.
    const result = planned.result as Record<string, unknown> | null;
    const plan = (result && "plan" in result ? result.plan : result) as { command: string; args: string; prompt: string; warning?: string } | null;
    if (!plan) return { ok: true, plan: null, run: null };
    if (plan.warning) return { ok: true, plan, run: null };
    return { ok: true, plan, run: await run.run(workspaceId, cwd, plan) };
  });

  server.handle(docketRun, ({ workspaceId, cwd, plan }, { paseo }) => runnerFor(paseo).run(workspaceId, cwd, plan));

  server.handle(docketAgents, ({ workspaceId }, { paseo }) => runnerFor(paseo).describe(workspaceId));

  server.handle(docketSetTarget, ({ workspaceId, agentId }, { paseo }) => {
    runnerFor(paseo).setTarget(workspaceId, agentId);
    return { ok: true };
  });

  server.handle(docketCancelPending, ({ workspaceId }, { paseo }) => ({ dropped: runnerFor(paseo).cancel(workspaceId) }));

  const offTurn = server.on("agent.turn_ended", async ({ agent }, { paseo }) => {
    // The agent reports idle a moment after the turn ends.
    await new Promise((resolve) => setTimeout(resolve, 500));
    await runnerFor(paseo).flush(agent.id);
  });
  const offArchived = server.on("agent.archived", ({ agent }, { paseo }) => {
    runnerFor(paseo).forget(agent.id);
  });
  const timer = setInterval(() => {
    runner?.flushAll().catch((error) => console.error("[docket] flush failed:", error));
  }, FLUSH_MS);

  return () => {
    clearInterval(timer);
    offTurn();
    offArchived();
  };
}
