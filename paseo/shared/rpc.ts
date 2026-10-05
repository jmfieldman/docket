// RPC contracts between the Docket panel (client) and the daemon subprocess
// (server). The server owns all file and git access and every agent prompt.
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** The same envelope as `docket api`: a result, or a docket error code and message. */
const Envelope = z.object({
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});
export type ApiEnvelope = z.infer<typeof Envelope>;

/** Reads and user actions: the docket action layer (src/api.ts), run in the daemon. */
export const docketApi = defineRpc({
  name: "docket.api",
  input: z.object({
    cwd: z.string(),
    op: z.enum(["snapshot", "finding", "action", "worktrees"]),
    name: z.string().optional(),
    args: z.record(z.string(), z.unknown()).optional(),
  }),
  output: Envelope,
});

export const AgentPlan = z.object({
  command: z.string(),
  args: z.string(),
  prompt: z.string(),
  warning: z.string().optional(),
  resumeSessionId: z.string().optional(),
});
export type AgentPlanValue = z.infer<typeof AgentPlan>;

const RunResult = z.object({
  status: z.enum(["sent", "queued", "created", "failed"]),
  agentId: z.string().optional(),
  message: z.string(),
});
export type RunResultValue = z.infer<typeof RunResult>;

/**
 * Plans agent work (docket's plan()) and runs the skill in the workspace's
 * Claude agent. A plan with a warning comes back unrun, for "Run anyway".
 */
export const docketPlan = defineRpc({
  name: "docket.plan",
  input: z.object({
    workspaceId: z.string(),
    cwd: z.string(),
    kind: z.enum(["ingest", "research", "apply", "reply", "discuss", "quickFix"]),
    args: z.record(z.string(), z.unknown()).optional(),
  }),
  output: z.object({
    ok: z.boolean(),
    error: z.object({ code: z.string(), message: z.string() }).optional(),
    plan: AgentPlan.nullable().optional(),
    run: RunResult.nullable().optional(),
  }),
});

/** Runs a plan as it is: Start, and "Run anyway" after a warning. */
export const docketRun = defineRpc({
  name: "docket.run",
  input: z.object({ workspaceId: z.string(), cwd: z.string(), plan: AgentPlan }),
  output: RunResult,
});

const AgentRow = z.object({
  id: z.string(),
  title: z.string().nullable(),
  status: z.string(),
  model: z.string().nullable(),
  lastActivityAt: z.string().nullable(),
});
export type AgentRowValue = z.infer<typeof AgentRow>;

/** The workspace's Claude agents, which one runs docket skills, and what waits for it. */
export const docketAgents = defineRpc({
  name: "docket.agents",
  input: z.object({ workspaceId: z.string() }),
  output: z.object({
    agents: z.array(AgentRow),
    targetId: z.string().nullable(),
    pending: z.array(z.object({ agentId: z.string(), prompt: z.string() })),
  }),
});

/** Chooses the agent that runs docket skills in a workspace. */
export const docketSetTarget = defineRpc({
  name: "docket.set-target",
  input: z.object({ workspaceId: z.string(), agentId: z.string() }),
  output: z.object({ ok: z.boolean() }),
});

/** Drops the skill runs that wait in a workspace. */
export const docketCancelPending = defineRpc({
  name: "docket.cancel-pending",
  input: z.object({ workspaceId: z.string() }),
  output: z.object({ dropped: z.number() }),
});

const OverviewItem = z.object({
  dir: z.string(),
  state: z.string(),
  branch: z.string().nullable(),
  pr: z.number().nullable(),
  open: z.number(),
  lanes: z.record(z.string(), z.number()),
  queued: z.number(),
  drafts: z.number(),
  isNew: z.number(),
  error: z.string().nullable(),
});
export type OverviewItemValue = z.infer<typeof OverviewItem>;

/** Docket state in many worktrees at once, for the sidebar overview. */
export const docketOverview = defineRpc({
  name: "docket.overview",
  input: z.object({ dirs: z.array(z.string()) }),
  output: z.object({ items: z.array(OverviewItem) }),
});
