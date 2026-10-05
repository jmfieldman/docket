// The docket action layer, run in the daemon subprocess. docket-api.cjs is
// src/api.ts bundled by `pnpm run bundle`, so this plugin reads and writes
// exactly what the CLI and the Claude Code pane do.
import { action, finding, plan, snapshot, worktrees, type ActionName, type PlanKind } from "./docket-api.cjs";
import type { ApiEnvelope, OverviewItemValue } from "../shared/rpc";

function envelope(run: () => unknown): ApiEnvelope {
  try {
    return { ok: true, result: run() ?? null };
  } catch (error) {
    const e = error as { name?: string; code?: unknown; message?: string };
    const code = e && e.name === "DocketError" && typeof e.code === "string" ? e.code : "internal";
    return { ok: false, error: { code, message: e && e.message ? e.message : String(error) } };
  }
}

function absolute(cwd: string): string {
  if (!cwd.startsWith("/")) throw Object.assign(new Error("The workspace has no absolute directory."), { name: "DocketError", code: "bad_input" });
  return cwd;
}

export function callApi(cwd: string, op: "snapshot" | "finding" | "action" | "worktrees", name?: string, args?: Record<string, unknown>): ApiEnvelope {
  return envelope(() => {
    const path = absolute(cwd);
    switch (op) {
      case "snapshot":
        return snapshot(path);
      case "worktrees":
        return worktrees(path);
      case "finding":
        return finding(path, name ?? "");
      case "action":
        return action(path, (name ?? "") as ActionName, args ?? {});
    }
  });
}

export function callPlan(cwd: string, kind: PlanKind, args: Record<string, unknown>): ApiEnvelope {
  return envelope(() => plan(absolute(cwd), kind, args));
}

interface Summary {
  open: boolean;
  state: string;
  lane: string | null;
  isNew: boolean;
  replyStatus: string;
}

/** One worktree's docket at a glance. Never throws: a broken worktree reports its error. */
export function overviewOf(dir: string): OverviewItemValue {
  const base = { dir, branch: null, pr: null, open: 0, lanes: {}, queued: 0, drafts: 0, isNew: 0, error: null };
  const read = envelope(() => snapshot(absolute(dir), { prLookup: false }));
  if (!read.ok) return { ...base, state: "error", error: read.error?.message ?? "unreadable" };
  const snap = read.result as {
    state: string;
    worktree?: { branch?: string | null } | null;
    unit?: { branch?: string; pr?: { number: number } | null } | null;
    summaries?: Summary[];
  };
  const sums = snap.summaries ?? [];
  const open = sums.filter((s) => s.open);
  const lanes: Record<string, number> = {};
  for (const s of open) {
    const lane = s.state === "needs_attention" ? "attention" : s.lane || "research";
    lanes[lane] = (lanes[lane] ?? 0) + 1;
  }
  return {
    ...base,
    state: snap.state,
    branch: snap.unit?.branch ?? snap.worktree?.branch ?? null,
    pr: snap.unit?.pr?.number ?? null,
    open: open.length,
    lanes,
    queued: open.filter((s) => s.state === "queued" || s.state === "fixing").length,
    drafts: sums.filter((s) => !s.open && s.replyStatus === "drafted").length,
    isNew: sums.filter((s) => s.isNew).length,
  };
}
