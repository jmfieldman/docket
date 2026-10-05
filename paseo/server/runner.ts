// Runs docket skills (/docket:apply, /docket:ingest ...) in a workspace's
// Claude agent. The Claude agent loads the docket Claude Code plugin from the
// user's Claude settings, so the skills are the same ones the CLI runs.
//
// An agent takes one prompt at a time: Paseo refuses a prompt while a turn
// runs. A skill run for a busy agent waits here, in the daemon, and goes out
// when the agent's turn ends, so it survives the panel closing.
import type { PaseoApi, PaseoAgent } from "@getpaseo/client";
import type { AgentPlanValue, AgentRowValue, RunResultValue } from "../shared/rpc";

type Plan = Pick<AgentPlanValue, "command" | "args" | "prompt">;

interface Pending {
  workspaceId: string;
  prompt: string;
}

const isClaude = (agent: PaseoAgent) => agent.provider === "claude" || agent.provider.startsWith("claude/");
const usable = (agent: PaseoAgent) => !agent.archivedAt && agent.status !== "closed" && agent.status !== "error";
const busy = (status: string | null | undefined) => status === "running" || status === "initializing";
const recency = (agent: PaseoAgent) => agent.lastUserMessageAt ?? agent.updatedAt ?? agent.createdAt ?? "";

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class Runner {
  private readonly targets = new Map<string, string>(); // workspace id -> agent id
  private readonly pending = new Map<string, Pending[]>(); // agent id -> prompts, oldest first
  private readonly hasDocket = new Map<string, boolean>(); // agent id -> docket skills loaded
  private readonly flushing = new Set<string>();
  private readonly paseo: PaseoApi;

  constructor(paseo: PaseoApi) {
    this.paseo = paseo;
  }

  /** The workspace's live Claude agents, most recently used first. */
  async agentsIn(workspaceId: string): Promise<PaseoAgent[]> {
    const listed = await this.paseo.agents.list({ filter: { includeArchived: false }, page: { limit: 500 } });
    return listed.entries
      .map((entry) => entry.agent)
      .filter((agent) => agent.workspaceId === workspaceId && isClaude(agent) && usable(agent))
      .sort((a, b) => recency(b).localeCompare(recency(a)));
  }

  /** The chosen agent if it is still live, else the most recently used one. */
  async target(workspaceId: string): Promise<PaseoAgent | null> {
    const agents = await this.agentsIn(workspaceId);
    const chosen = this.targets.get(workspaceId);
    return agents.find((agent) => agent.id === chosen) ?? agents[0] ?? null;
  }

  setTarget(workspaceId: string, agentId: string): void {
    this.targets.set(workspaceId, agentId);
  }

  async describe(workspaceId: string): Promise<{ agents: AgentRowValue[]; targetId: string | null; pending: { agentId: string; prompt: string }[] }> {
    const agents = await this.agentsIn(workspaceId);
    const chosen = this.targets.get(workspaceId);
    const target = agents.find((agent) => agent.id === chosen) ?? agents[0] ?? null;
    const pending: { agentId: string; prompt: string }[] = [];
    for (const [agentId, items] of this.pending) {
      for (const item of items) if (item.workspaceId === workspaceId) pending.push({ agentId, prompt: item.prompt });
    }
    return {
      agents: agents.map((agent) => ({
        id: agent.id,
        title: agent.title,
        status: agent.status,
        model: agent.model,
        lastActivityAt: agent.lastUserMessageAt ?? agent.updatedAt ?? null,
      })),
      targetId: target?.id ?? null,
      pending,
    };
  }

  /** The Claude session id behind an agent, which docket records as the applier's session. */
  async sessionIdOf(workspaceId: string): Promise<string | undefined> {
    const agent = await this.target(workspaceId);
    const persistence = agent?.persistence;
    return persistence ? (persistence.nativeHandle ?? persistence.sessionId) : undefined;
  }

  /** Sends a skill to the workspace's Claude agent, queues it while that agent works, or starts an agent. */
  async run(workspaceId: string, cwd: string, plan: Plan): Promise<RunResultValue> {
    let agent: PaseoAgent | null;
    try {
      agent = await this.target(workspaceId);
    } catch (error) {
      return { status: "failed", message: "Could not list this workspace's agents: " + messageOf(error) };
    }

    if (!agent) {
      try {
        const created = await this.paseo.workspaces.ref(workspaceId).agents.create({
          config: { provider: "claude" },
          title: "Docket",
          prompt: plan.prompt,
          labels: { docket: "true" },
        });
        this.targets.set(workspaceId, created.id);
        return { status: "created", agentId: created.id, message: "Started a Claude agent for " + plan.prompt + "." };
      } catch (error) {
        return { status: "failed", message: "Could not start a Claude agent in " + cwd + ": " + messageOf(error) };
      }
    }

    const missing = await this.lacksDocket(agent);
    if (missing) {
      return {
        status: "failed",
        agentId: agent.id,
        message: "This Claude agent has no docket skills. Install the docket Claude Code plugin (see the docket README), then start a new agent.",
      };
    }

    if (busy(agent.status) || this.queueOf(agent.id).length) {
      return this.enqueue(workspaceId, agent.id, plan.prompt);
    }
    try {
      await this.paseo.agents.ref(agent.id).send(plan.prompt);
      return { status: "sent", agentId: agent.id, message: "Running " + plan.prompt + " in " + (agent.title ?? "the Claude agent") + "." };
    } catch (error) {
      // A turn started between the status read and the send.
      if (/turn is already active|already running|busy/i.test(messageOf(error))) return this.enqueue(workspaceId, agent.id, plan.prompt);
      return { status: "failed", agentId: agent.id, message: plan.prompt + " could not start: " + messageOf(error) };
    }
  }

  cancel(workspaceId: string): number {
    let dropped = 0;
    for (const [agentId, items] of this.pending) {
      const kept = items.filter((item) => item.workspaceId !== workspaceId);
      dropped += items.length - kept.length;
      if (kept.length) this.pending.set(agentId, kept);
      else this.pending.delete(agentId);
    }
    return dropped;
  }

  forget(agentId: string): void {
    this.pending.delete(agentId);
    this.hasDocket.delete(agentId);
    for (const [workspaceId, target] of this.targets) if (target === agentId) this.targets.delete(workspaceId);
  }

  /** Sends the next waiting prompt when the agent is idle. Its own turn sends the rest. */
  async flush(agentId: string): Promise<void> {
    const queue = this.queueOf(agentId);
    if (!queue.length || this.flushing.has(agentId)) return;
    this.flushing.add(agentId);
    try {
      const handle = this.paseo.agents.ref(agentId);
      const refreshed = await handle.refresh().catch(() => null);
      if (!refreshed) {
        this.forget(agentId);
        return;
      }
      if (busy(refreshed.agent.status)) return;
      if (!usable(refreshed.agent)) {
        this.forget(agentId);
        return;
      }
      const next = queue[0];
      try {
        await handle.send(next.prompt);
        queue.shift();
        if (!queue.length) this.pending.delete(agentId);
      } catch (error) {
        console.error(`[docket] could not send ${next.prompt} to ${agentId}: ${messageOf(error)}`);
      }
    } finally {
      this.flushing.delete(agentId);
    }
  }

  /** Every agent with waiting prompts. A timer calls this in case a turn-ended event was missed. */
  async flushAll(): Promise<void> {
    for (const agentId of [...this.pending.keys()]) await this.flush(agentId);
  }

  private queueOf(agentId: string): Pending[] {
    return this.pending.get(agentId) ?? [];
  }

  private enqueue(workspaceId: string, agentId: string, prompt: string): RunResultValue {
    const queue = this.queueOf(agentId);
    if (!queue.some((item) => item.prompt === prompt)) queue.push({ workspaceId, prompt });
    this.pending.set(agentId, queue);
    return { status: "queued", agentId, message: "Waiting for Claude to finish, then " + prompt + " runs." };
  }

  /** True only when the agent answered and listed no docket skill. Unknown is not missing. */
  private async lacksDocket(agent: PaseoAgent): Promise<boolean> {
    const known = this.hasDocket.get(agent.id);
    if (known !== undefined) return !known;
    try {
      const listed = await this.paseo.agents.ref(agent.id).commands();
      if (listed.error || !listed.commands.length) return false;
      const found = listed.commands.some((command) => command.name.replace(/^\//, "").startsWith("docket:"));
      this.hasDocket.set(agent.id, found);
      return !found;
    } catch {
      return false;
    }
  }
}
