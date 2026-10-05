// Display constants shared by the panel and the overview. They match the
// Claude Code pane (plugin/hooks/pane.js).

/** [lane, heading, where it sits on the two triage axes, what to do] */
export const LANES: ReadonlyArray<readonly [string, string, string, string]> = [
  ["attention", "Needs attention", "", "The applier stopped. Re-decide or discuss."],
  ["quick", "Quick", "low complexity, high confidence", "Accept and go."],
  ["decide", "Decide", "low complexity, low confidence", "A small change, but a judgment call."],
  ["scope", "Scope", "high complexity, high confidence", "Clear direction, large change: fix now or defer."],
  ["dig", "Dig", "high complexity, low confidence", "Discuss before deciding."],
  ["research", "Needs research", "", "Not researched yet."],
];

export const SEVERITY_COLOR: Readonly<Record<string, string>> = {
  critical: "#ff5f5f",
  high: "#ff8700",
  medium: "#d7af00",
  low: "#5fafd7",
};

export const OUTCOME: Readonly<Record<string, string>> = {
  completed: "Completed",
  acknowledged: "Acknowledged",
  deferred: "Deferred",
  resolved_externally: "Resolved on GitHub",
};

export const STATE_LABEL: Readonly<Record<string, string>> = {
  queued: "queued",
  fixing: "fixing",
  discussing: "discussing",
  needs_attention: "needs attention",
};

export const DOCKET_STATE_LABEL: Readonly<Record<string, string>> = {
  active: "active",
  paused: "paused",
  not_started: "not started",
  branch_mismatch: "branch changed",
};

export const START_PLAN = { command: "docket:start", args: "", prompt: "/docket:start" } as const;

export const PANEL_ID = "docket";
/** Where docket opens the panel: the Explorer, Paseo's right-hand pane. */
export const PANEL_LOCATION = { location: "explorer" } as const;
export const SURFACE_ID = "overview";

/** A summary's lane: needs_attention first, then its triage lane, else research. */
export function laneOf(summary: { state: string; lane?: string | null }): string {
  if (summary.state === "needs_attention") return "attention";
  return summary.lane || "research";
}
