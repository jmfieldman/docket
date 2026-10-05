// The loose shapes the panel reads from docket's JSON, and the envelope unwrap.
import type { ApiEnvelope } from "../shared/rpc";

export interface Summary {
  id: string;
  rev: number;
  title: string;
  state: string;
  open: boolean;
  lane: string | null;
  severity: string | null;
  recommended: { id: string; kind: string; title: string } | null;
  stale: string | null;
  isNew: boolean;
  resolutionSummary: string | null;
  replyStatus: string;
}

export interface Snapshot {
  state: string;
  message?: string;
  worktree?: { root?: string; branch?: string | null } | null;
  unit: {
    branch?: string;
    pr?: { number: number; url?: string } | null;
    remoteCheck?: { newSourceCount: number } | null;
    applier?: { state: string } | null;
  } | null;
  unpushedCommits?: number | null;
  counts: Record<string, number>;
  summaries: Summary[];
  deferralsOpen?: number;
}

export class DocketCallError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export function unwrap<T>(envelope: ApiEnvelope): T {
  if (!envelope.ok) throw new DocketCallError(envelope.error?.code ?? "internal", envelope.error?.message ?? "docket failed");
  return envelope.result as T;
}
