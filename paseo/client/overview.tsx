// Docket across every Paseo workspace: which worktrees have a docket, and
// how many findings wait in each lane. Pressing a workspace opens its Docket
// panel.
import { usePaseo, useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import { DOCKET_STATE_LABEL, LANES, PANEL_ID } from "../shared/model";
import { docketOverview, type OverviewItemValue } from "../shared/rpc";
import { openDocketPanel } from "./bridge";
import { Button, Card, Row, T, type Kit } from "./ui";

const POLL_MS = 10000;

interface WorkspaceRow {
  id: string;
  project: string;
  name: string;
  dir: string;
}

export function DocketOverview({ theme, layout, navigation }: PluginSurfaceProps) {
  const kit: Kit = useMemo(() => ({ theme, compact: layout.compact }), [theme, layout.compact]);
  const c = theme.colors;
  const paseo = usePaseo();
  const overview = useRpc(docketOverview);
  const [showAll, setShowAll] = useState(false);

  const workspaces = useQuery({
    queryKey: ["docket", "workspaces"],
    queryFn: async (): Promise<WorkspaceRow[]> => {
      const listed = await paseo.workspaces.list();
      return listed.entries
        .filter((w) => !w.archivingAt)
        .map((w) => ({ id: w.id, project: w.projectCustomName ?? w.projectDisplayName, name: w.title ?? w.name, dir: w.workspaceDirectory ?? w.projectRootPath }));
    },
    refetchInterval: POLL_MS,
  });
  const dirs = (workspaces.data ?? []).map((w) => w.dir);
  const states = useQuery({
    queryKey: ["docket", "overview", dirs],
    enabled: dirs.length > 0,
    queryFn: () => overview({ dirs }),
    refetchInterval: POLL_MS,
  });

  const pad = layout.compact ? 12 : 20;
  const byDir = new Map<string, OverviewItemValue>((states.data?.items ?? []).map((item) => [item.dir, item]));
  const rows = (workspaces.data ?? []).map((w) => ({ w, item: byDir.get(w.dir) }));
  const withDocket = rows.filter(({ item }) => item && (item.state === "active" || item.state === "paused"));
  const shown = showAll ? rows : withDocket;

  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.surface0 }} contentContainerStyle={{ padding: pad, gap: 12 }}>
      <T kit={kit} bold size={18}>Docket</T>
      <T kit={kit} muted size={13}>Review findings in every workspace. Open one to triage, decide and apply.</T>
      <Row>
        <Button kit={kit} selected={!showAll} label={"With a docket (" + withDocket.length + ")"} onPress={() => setShowAll(false)} />
        <Button kit={kit} selected={showAll} label={"All workspaces (" + rows.length + ")"} onPress={() => setShowAll(true)} />
      </Row>
      {workspaces.isError ? <T kit={kit} color={c.statusDanger}>{"Could not list workspaces: " + workspaces.error.message}</T> : null}
      {states.isError ? <T kit={kit} color={c.statusDanger}>{"Could not read docket: " + states.error.message}</T> : null}
      {workspaces.isPending ? <T kit={kit} muted>Loading…</T> : null}
      {!workspaces.isPending && !shown.length ? (
        <T kit={kit} muted>{showAll ? "No workspaces." : "No workspace has a docket yet. Open a workspace's Docket panel and press Start docket."}</T>
      ) : null}
      {shown.map(({ w, item }) => (
        <Pressable
          key={w.id}
          accessibilityRole="button"
          accessibilityLabel={"Open Docket for " + w.project + " " + w.name}
          onPress={() => {
            navigation?.openWorkspace({ workspaceId: w.id });
            openDocketPanel(PANEL_ID, w.id);
          }}
        >
          {({ pressed }) => (
            <View style={{ opacity: pressed ? 0.7 : 1 }}>
              <Card kit={kit}>
                <T kit={kit} bold>
                  {w.project + " · " + w.name}
                  {item?.branch && item.branch !== w.name ? <T kit={kit} muted size={12}>{"  " + item.branch}</T> : null}
                </T>
                <T kit={kit} muted size={12}>
                  {[item ? (DOCKET_STATE_LABEL[item.state] ?? item.state) : "…", item?.pr ? "PR #" + item.pr : ""].filter(Boolean).join(" · ")}
                </T>
                {item?.error ? <T kit={kit} muted size={12}>{item.error}</T> : null}
                {item && (item.state === "active" || item.state === "paused") ? (
                  <Row gap={10}>
                    <T kit={kit} size={13} bold>{item.open + " open"}</T>
                    {LANES.map(([lane, label]) =>
                      item.lanes[lane] ? (
                        <T key={lane} kit={kit} size={13} color={lane === "attention" ? c.statusDanger : undefined}>
                          {label + " " + item.lanes[lane]}
                        </T>
                      ) : null,
                    )}
                    {item.queued ? <T kit={kit} size={13} color={c.statusWarning}>{item.queued + " queued"}</T> : null}
                    {item.drafts ? <T kit={kit} size={13} muted>{item.drafts + " reply draft" + (item.drafts === 1 ? "" : "s")}</T> : null}
                    {item.isNew ? <T kit={kit} size={13} color={c.accent}>{item.isNew + " new"}</T> : null}
                  </Row>
                ) : null}
              </Card>
            </View>
          )}
        </Pressable>
      ))}
    </ScrollView>
  );
}
