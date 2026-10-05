// The Docket plugin's app side: a Docket panel per workspace, a sidebar
// overview across workspaces, a /docket composer command, and ⌘K actions.
import type { PluginClientContext, PluginWorkspaceCommandContext } from "@getpaseo/plugin/client";
import { PANEL_ID, PANEL_LOCATION, SURFACE_ID } from "./shared/model";
import { docketPlan, docketSetTarget } from "./shared/rpc";
import { setClient } from "./client/bridge";
import { DocketOverview } from "./client/overview";
import { DocketPanel } from "./client/panel";

type RunKind = "ingest" | "research" | "apply" | "reply";

const RUN_ITEMS: ReadonlyArray<{ kind: RunKind; title: string; icon: string }> = [
  { kind: "ingest", title: "Docket: Ingest reviews", icon: "Inbox" },
  { kind: "research", title: "Docket: Research new findings", icon: "Search" },
  { kind: "apply", title: "Docket: Apply the queue", icon: "Hammer" },
  { kind: "reply", title: "Docket: Draft and post replies", icon: "MessageSquareReply" },
];

/** Runs a plan from ⌘K, then opens the panel, which shows the run's state. */
async function runFromCommand(context: PluginWorkspaceCommandContext, kind: RunKind) {
  context.openPanel(PANEL_ID, PANEL_LOCATION);
  await context.rpc(docketPlan, { workspaceId: context.workspace.id, cwd: context.workspace.directory, kind });
}

export default function contribute(client: PluginClientContext) {
  setClient(client);
  const removers = [
    // The Explorer is the right-hand pane; the panel can also open as a center tab.
    client.addWorkspacePanel({ id: PANEL_ID, title: "Docket", icon: "ListChecks", context: "workspace", locations: ["explorer", "workspace"], Component: DocketPanel }),
    client.addSurface(SURFACE_ID, DocketOverview),
    client.addSidebarItem({ id: SURFACE_ID, title: "Docket", icon: "ListChecks", surface: SURFACE_ID }),
    client.addSlashCommand({
      name: "docket",
      description: "Open the Docket panel; docket skills run in this agent",
      argumentHint: "",
      context: "agent",
      async onSubmit({ workspace, agent, rpc, openPanel }) {
        await rpc(docketSetTarget, { workspaceId: workspace.id, agentId: agent.id });
        openPanel(PANEL_ID, PANEL_LOCATION);
      },
    }),
    client.addCommandCenterItem({
      id: "open",
      title: "Docket: Open panel",
      icon: "ListChecks",
      keywords: ["docket", "findings", "review"],
      context: "workspace",
      onSelect({ openPanel }) {
        openPanel(PANEL_ID, PANEL_LOCATION);
      },
    }),
    client.addCommandCenterItem({
      id: "overview",
      title: "Docket: All workspaces",
      icon: "LayoutList",
      keywords: ["docket", "findings", "overview"],
      context: "global",
      onSelect({ openSurface }) {
        openSurface(SURFACE_ID);
      },
    }),
    ...RUN_ITEMS.map((item) =>
      client.addCommandCenterItem({
        id: item.kind,
        title: item.title,
        icon: item.icon,
        keywords: ["docket", item.kind],
        context: "workspace",
        onSelect: (context) => runFromCommand(context, item.kind),
      }),
    ),
  ];
  return async () => {
    setClient(null);
    for (const remove of removers) await remove();
  };
}
