// The client context, kept for components that need capabilities surfaces do
// not receive as props (opening the Docket panel in another workspace).
import type { PluginClientContext } from "@getpaseo/plugin/client";

let current: PluginClientContext | null = null;

export function setClient(client: PluginClientContext | null): void {
  current = client;
}

export function openDocketPanel(panelId: string, workspaceId: string): void {
  current?.openPanel(panelId, { workspaceId, location: "explorer" });
}
