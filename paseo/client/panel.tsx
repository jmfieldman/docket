// The Docket panel: a workspace tab beside agents, terminals and files. It
// shows the worktree's findings by lane and records decisions. Agent work
// (ingest, research, apply, replies, discussion) runs as docket skills in the
// workspace's Claude agent.
import { useRpc, useWorkspace, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import { DOCKET_STATE_LABEL, LANES, laneOf, OUTCOME, START_PLAN, STATE_LABEL } from "../shared/model";
import { docketAgents, docketApi, docketCancelPending, docketPlan, docketRun, docketSetTarget, type AgentPlanValue } from "../shared/rpc";
import { FindingDetail, type FindingActions } from "./finding";
import { unwrap, type Snapshot, type Summary } from "./types";
import { Button, Row, T, type Kit } from "./ui";

const POLL_MS = 2500;

type PlanKind = "ingest" | "research" | "apply" | "reply" | "discuss" | "quickFix";

export function severityColor(kit: Kit, severity: string | null): string {
  const c = kit.theme.colors;
  if (severity === "critical" || severity === "high") return c.statusDanger;
  if (severity === "medium") return c.statusWarning;
  if (severity === "low") return c.accent;
  return c.foregroundMuted;
}

export function DocketPanel({ theme, layout, workspaceId }: PluginWorkspacePanelProps) {
  const kit: Kit = useMemo(() => ({ theme, compact: layout.compact }), [theme, layout.compact]);
  const c = theme.colors;
  const cwd = useWorkspace(workspaceId, (workspace) => workspace.directory);
  const api = useRpc(docketApi);
  const planRpc = useRpc(docketPlan);
  const runRpc = useRpc(docketRun);
  const agentsRpc = useRpc(docketAgents);
  const setTargetRpc = useRpc(docketSetTarget);
  const cancelRpc = useRpc(docketCancelPending);
  const queryClient = useQueryClient();

  const snapshot = useQuery({
    queryKey: ["docket", "snapshot", cwd],
    enabled: !!cwd,
    queryFn: async () => unwrap<Snapshot>(await api({ cwd: cwd as string, op: "snapshot" })),
    refetchInterval: POLL_MS,
  });
  const agents = useQuery({
    queryKey: ["docket", "agents", workspaceId],
    queryFn: () => agentsRpc({ workspaceId }),
    refetchInterval: POLL_MS,
  });

  const [tab, setTab] = useState<"open" | "closed">("open");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<AgentPlanValue | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["docket", "snapshot", cwd] }),
      queryClient.invalidateQueries({ queryKey: ["docket", "finding", cwd] }),
      queryClient.invalidateQueries({ queryKey: ["docket", "agents", workspaceId] }),
    ]);
  }, [queryClient, cwd, workspaceId]);

  const act = useCallback(
    async (name: string, args: Record<string, unknown>, done: string | null) => {
      if (!cwd || busy) return;
      setBusy(true);
      try {
        const result = await api({ cwd, op: "action", name, args });
        setMessage(result.ok ? done : (result.error?.message ?? "docket failed"));
      } catch (error) {
        setMessage(error instanceof Error ? error.message : String(error));
      }
      setBusy(false);
      await refresh();
    },
    [api, cwd, busy, refresh],
  );

  const run = useCallback(
    async (plan: AgentPlanValue) => {
      if (!cwd) return;
      setConfirm(null);
      try {
        const result = await runRpc({ workspaceId, cwd, plan });
        setMessage(result.message);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : String(error));
      }
      await refresh();
    },
    [runRpc, workspaceId, cwd, refresh],
  );

  const plan = useCallback(
    async (kind: PlanKind, args: Record<string, unknown> = {}) => {
      if (!cwd || busy) return;
      setBusy(true);
      try {
        const result = await planRpc({ workspaceId, cwd, kind, args });
        if (!result.ok) setMessage(result.error?.message ?? "docket failed");
        else if (result.plan?.warning) {
          setConfirm(result.plan);
          setMessage(result.plan.warning);
        } else if (result.run) setMessage((kind === "quickFix" ? "Queued " + String(args.id) + ". " : "") + result.run.message);
        else if (kind === "quickFix") setMessage("Decided " + String(args.id) + ".");
      } catch (error) {
        setMessage(error instanceof Error ? error.message : String(error));
      }
      setBusy(false);
      await refresh();
    },
    [planRpc, workspaceId, cwd, busy, refresh],
  );

  const findingActions: FindingActions = useMemo(() => ({ act, plan, say: setMessage }), [act, plan]);

  const pad = layout.compact ? 12 : 20;
  const screen = { flex: 1, backgroundColor: c.surface0 } as const;
  const body = { padding: pad, gap: 10 } as const;

  if (!cwd) {
    return (
      <View style={[screen, body]}>
        <T kit={kit} muted>Loading the workspace…</T>
      </View>
    );
  }
  if (snapshot.isPending) {
    return (
      <View style={[screen, body]}>
        <T kit={kit} muted>Loading…</T>
      </View>
    );
  }
  if (snapshot.isError && !snapshot.data) {
    return (
      <View style={[screen, body]}>
        <T kit={kit} bold>Docket cannot read this workspace.</T>
        <T kit={kit} muted>{snapshot.error.message}</T>
      </View>
    );
  }

  const snap = snapshot.data as Snapshot;
  const state = snap.state;
  const unit = snap.unit ?? {};
  const branch = unit.branch ?? snap.worktree?.branch ?? "";
  const agentInfo = agents.data;
  const target = agentInfo?.agents.find((agent) => agent.id === agentInfo.targetId) ?? null;
  const working = target?.status === "running";
  const head = ["Docket", branch, DOCKET_STATE_LABEL[state] ?? state];
  if (unit.pr) head.push("PR #" + unit.pr.number);

  const agentStrip = (
    <View style={{ gap: 6 }}>
      {agentInfo && agentInfo.agents.length > 0 ? (
        <Row gap={6}>
          <T kit={kit} muted size={12}>Skills run in</T>
          {agentInfo.agents.map((agent) => (
            <Button
              key={agent.id}
              kit={kit}
              selected={agent.id === agentInfo.targetId}
              label={(agent.status === "running" ? "● " : "") + (agent.title ?? "Claude agent " + agent.id.slice(0, 6))}
              onPress={async () => {
                await setTargetRpc({ workspaceId, agentId: agent.id });
                await refresh();
              }}
            />
          ))}
        </Row>
      ) : agentInfo ? (
        <T kit={kit} muted size={12}>No Claude agent in this workspace yet. Docket starts one when you run a skill.</T>
      ) : null}
      {agentInfo && agentInfo.pending.length > 0 ? (
        <Row gap={6}>
          <T kit={kit} muted size={12}>{"Waiting for Claude: " + agentInfo.pending.map((p) => p.prompt).join(", ")}</T>
          <Button
            kit={kit}
            tone="quiet"
            label="Cancel waiting"
            onPress={async () => {
              const { dropped } = await cancelRpc({ workspaceId });
              setMessage("Dropped " + dropped + " waiting run" + (dropped === 1 ? "" : "s") + ".");
              await refresh();
            }}
          />
        </Row>
      ) : null}
    </View>
  );

  const header = (
    <View style={{ gap: 4 }}>
      <T kit={kit} bold size={16}>
        {head.filter(Boolean).join(" · ")}
        {working ? <T kit={kit} color={c.statusWarning} size={13}>{"  · Claude is working"}</T> : null}
      </T>
    </View>
  );

  const notice = (
    <View style={{ gap: 4 }}>
      {message ? <T kit={kit} muted size={13}>{message}</T> : null}
      {snapshot.isError ? <T kit={kit} color={c.statusDanger} size={13}>{"Last read failed: " + snapshot.error.message}</T> : null}
      {confirm ? (
        <Row>
          <Button kit={kit} tone="primary" label={"Run " + confirm.prompt + " anyway"} onPress={() => run(confirm)} />
          <Button
            kit={kit}
            tone="quiet"
            label="Cancel"
            onPress={() => {
              setConfirm(null);
              setMessage(null);
            }}
          />
        </Row>
      ) : null}
    </View>
  );

  if (state === "not_started") {
    return (
      <ScrollView style={screen} contentContainerStyle={body}>
        {header}
        <T kit={kit}>Docket is not started in this worktree.</T>
        <T kit={kit} muted size={13}>
          It stays dormant here until you start it: no skills run on their own and no session brief appears. Start runs /docket:start in this workspace's Claude agent, which also ingests the reviews in that conversation and on the PR.
        </T>
        <Row>
          <Button kit={kit} tone="primary" label="Start docket" onPress={() => run({ ...START_PLAN })} />
        </Row>
        {snap.deferralsOpen ? <T kit={kit} muted size={13}>{snap.deferralsOpen + " deferred item(s) are waiting. Run /docket:deferrals to pick one up."}</T> : null}
        {agentStrip}
        {notice}
      </ScrollView>
    );
  }
  if (state !== "active" && state !== "paused") {
    return (
      <ScrollView style={screen} contentContainerStyle={body}>
        {header}
        <T kit={kit}>{snap.message ?? "Docket cannot use this worktree right now."}</T>
      </ScrollView>
    );
  }

  const sums = snap.summaries ?? [];
  const counts = snap.counts ?? {};
  const active = state === "active";
  const untriaged = sums.filter((s) => s.open && !s.lane && s.state === "new").length;
  const queued = (counts.queued ?? 0) + (counts.fixing ?? 0);
  const drafts = sums.filter((s) => !s.open && s.replyStatus === "drafted").length;
  const newCount = sums.filter((s) => s.isNew).length;
  const remoteNew = unit.remoteCheck ? unit.remoteCheck.newSourceCount : 0;
  const applierRunning = unit.applier?.state === "running";
  const badge = (label: string, n: number) => label + (n ? " (" + n + ")" : "");
  const openSums = sums.filter((s) => s.open);
  const closedSums = sums.filter((s) => !s.open);

  const toolbar = active ? (
    <Row>
      <Button kit={kit} label={badge("Ingest", remoteNew)} onPress={() => plan("ingest")} disabled={busy} />
      <Button kit={kit} label={badge("Research", untriaged)} onPress={() => plan("research")} disabled={busy} />
      <Button kit={kit} label={badge(applierRunning ? "Applying" : "Apply", queued)} onPress={() => plan("apply")} disabled={busy} />
      <Button kit={kit} label={badge("Replies", drafts)} onPress={() => plan("reply")} disabled={busy} />
      <Button kit={kit} tone="quiet" label="Pause" onPress={() => act("pause", {}, "Docket paused.")} disabled={busy} />
    </Row>
  ) : (
    <View style={{ gap: 6 }}>
      <T kit={kit}>Docket is paused. Skills and the session brief are dormant here; the data stays.</T>
      <Row>
        <Button kit={kit} tone="primary" label="Resume" onPress={() => act("resume", {}, "Docket resumed.")} />
      </Row>
    </View>
  );

  const tabs = (
    <Row>
      <Button kit={kit} selected={tab === "open"} label={"Open (" + openSums.length + ")"} onPress={() => setTab("open")} />
      <Button kit={kit} selected={tab === "closed"} label={"Closed (" + closedSums.length + ")"} onPress={() => setTab("closed")} />
      {newCount ? <Button kit={kit} tone="quiet" label={newCount + " new · mark seen"} onPress={() => act("view", {}, null)} /> : null}
      {snap.unpushedCommits ? <T kit={kit} muted size={12}>{snap.unpushedCommits + " unpushed commit" + (snap.unpushedCommits === 1 ? "" : "s")}</T> : null}
    </Row>
  );

  const row = (s: Summary) => {
    const open = expanded === s.id;
    const flags: string[] = [];
    if (s.open && STATE_LABEL[s.state]) flags.push(STATE_LABEL[s.state]);
    if (s.stale) flags.push("stale");
    if (s.isNew) flags.push("new");
    return (
      <View key={s.id} style={{ gap: 6 }}>
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={s.id + ": " + s.title} onPress={() => setExpanded(open ? null : s.id)}>
          {({ pressed }) => (
            <View style={{ gap: 2, opacity: pressed ? 0.7 : 1 }}>
              <T kit={kit}>
                <T kit={kit} muted>{(open ? "▾ " : "▸ ") + s.id + "  "}</T>
                {s.title}
                {flags.length ? <T kit={kit} muted size={12}>{"  [" + flags.join(", ") + "]"}</T> : null}
              </T>
              <View style={{ paddingLeft: 18 }}>
                {s.open ? (
                  <T kit={kit} size={13}>
                    <T kit={kit} size={13} bold={s.severity === "critical"} color={severityColor(kit, s.severity)}>{s.severity ?? "unknown"}</T>
                    {s.recommended ? <T kit={kit} muted size={13}>{"  → " + s.recommended.id + " " + s.recommended.title}</T> : null}
                  </T>
                ) : (
                  <T kit={kit} muted size={13}>{(OUTCOME[s.state] ?? s.state) + (s.resolutionSummary ? " — " + s.resolutionSummary : "")}</T>
                )}
              </View>
            </View>
          )}
        </Pressable>
        {open ? <FindingDetail kit={kit} cwd={cwd} summary={s} active={active} actions={findingActions} /> : null}
      </View>
    );
  };

  let list;
  if (!sums.length) {
    list = (
      <View style={{ gap: 4 }}>
        <T kit={kit}>No findings yet.</T>
        <T kit={kit} muted size={13}>Press Ingest to pick up reviews from this workspace's Claude conversation and the PR, or run /docket:ingest &lt;path&gt; for a local review report.</T>
      </View>
    );
  } else if (tab === "closed") {
    list = <View style={{ gap: 10 }}>{closedSums.length ? closedSums.map(row) : <T kit={kit} muted>Nothing closed yet.</T>}</View>;
  } else {
    list = (
      <View style={{ gap: 18 }}>
        {!openSums.length ? <T kit={kit} muted>No open findings. Open the Closed tab, or press Ingest for new review comments.</T> : null}
        {LANES.map(([lane, label, axes, hint]) => {
          const items = openSums.filter((s) => laneOf(s) === lane);
          if (!items.length) return null;
          const quickReady = lane === "quick" ? items.filter((s) => s.state === "ready" || s.state === "discussing") : [];
          return (
            <View key={lane} style={{ gap: 8 }}>
              <View style={{ gap: 2 }}>
                <T kit={kit} bold>
                  {label}
                  {axes ? <T kit={kit} muted size={12}>{"  (" + axes + ")"}</T> : null}
                  {" · " + items.length}
                </T>
                <T kit={kit} muted size={12}>{hint}</T>
              </View>
              {active && quickReady.length > 1 ? (
                <Row>
                  <Button kit={kit} tone="primary" label={"Accept all " + quickReady.length + " recommendations"} onPress={() => act("accept", { ids: quickReady.map((s) => s.id) }, "Accepted " + quickReady.length + ". Press Apply to apply them.")} />
                </Row>
              ) : null}
              <View style={{ gap: 10 }}>{items.map(row)}</View>
            </View>
          );
        })}
      </View>
    );
  }

  return (
    <ScrollView style={screen} contentContainerStyle={body}>
      {header}
      {toolbar}
      {tabs}
      {agentStrip}
      {notice}
      <View style={{ height: 1, backgroundColor: c.border, marginVertical: 4 }} />
      {list}
    </ScrollView>
  );
}
