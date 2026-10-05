# Docket for Paseo

This directory is a [Paseo](https://paseo.sh) plugin. It adds the Docket panel to each Paseo workspace. The Claude Code plugin in `../plugin` stays the engine: the skills, the CLI and the session brief. This plugin is a third surface, beside the Claude Code pane and the browser view.

## What it adds

| Contribution | Where | What it does |
|---|---|---|
| Docket panel | The Explorer (Paseo's right-hand pane), or a center tab beside agents, terminals and files | Findings by lane, the full finding, and the controls to decide, queue, quick-fix, leave as is, discuss, approve replies, reopen, pause and resume |
| Docket overview | The sidebar | Every workspace with a docket, with open findings per lane. Press a workspace to open its panel. |
| `/docket` | The composer of a Claude agent | Opens the panel and makes this agent the one that runs docket skills |
| ⌘K items | The Command Center | Open the panel, open the overview, ingest, research, apply, replies |

The panel and the overview are React Native, so they also work in the Paseo mobile apps.

## How it works

- The daemon side (`index.server.ts`) runs docket's action layer in process. `server/docket-api.cjs` is `../src/api.ts`, bundled by `pnpm run bundle` at the repository root. The panel therefore reads and writes the same files as the CLI and the Claude Code pane.
- Agent work (ingest, research, apply, replies, discussion) runs as a docket skill, such as `/docket:apply`, in the workspace's Claude agent. The Claude agent loads the docket Claude Code plugin from your Claude settings.
- The skills run in the most recently used Claude agent in the workspace. Press an agent in the panel's "Skills run in" row, or type `/docket` in an agent, to choose another one. If the workspace has no Claude agent, docket starts one.
- An agent takes one prompt at a time. While the agent works, a skill run waits in the daemon. It starts when the turn ends, also when the panel is closed. "Cancel waiting" drops the waiting runs.
- If an agent answers that it has no docket skills, the panel says so and sends nothing.

## Install

The docket Claude Code plugin must be installed first, so that Paseo's Claude agents load its skills. Read the root [README](../README.md).

Paseo runs plugins only when **Settings → Plugins → Enable plugins** is on. Plugins are trusted, unsandboxed code: backend plugin code can read files, start processes and use the network on the daemon machine.

1. Install the type dependencies (only needed for development):

   ```bash
   npm install --prefix ~/Development/docket/paseo
   ```

2. Install the plugin from this directory. Paseo runs it from this directory and does not copy it:

   ```bash
   paseo plugin install ~/Development/docket/paseo
   ```

3. Make sure that the plugin is running:

   ```bash
   paseo plugin ls
   ```

4. Open a workspace, then press ⌘K and select **Docket: Open panel**, or type `/docket` in a Claude agent. The panel opens in the Explorer, on the right. It is also available as a center tab.

## Develop

After you edit the plugin, reload it. Do not restart the daemon: a restart can stop the agents that run in it.

```bash
npm --prefix paseo run typecheck
npm --prefix paseo test
paseo plugin reload docket
paseo plugin logs docket
```

After you edit `src/`, run `pnpm run bundle` at the repository root to rebuild `server/docket-api.cjs`, then reload the plugin. `pnpm run check` fails when the committed bundle is stale.

Paseo compiles only the files that the entries import, and only from `client/`, `server/` and `shared/`. Client code must not import `server/` or any `node:` module. Text colors come from the host theme (`theme.colors`), so the panel works in light and dark themes.

## Files

| File | Purpose |
|---|---|
| `paseo-plugin.json` | Plugin id (`docket`) and the minimum Paseo version |
| `index.server.ts` | RPC handlers and lifecycle hooks in the daemon subprocess |
| `server/api.ts` | The docket action layer, and the per-worktree overview |
| `server/runner.ts` | Picks the Claude agent, sends skills, and queues them while the agent works |
| `server/docket-api.cjs` | Generated: `src/api.ts` with its dependencies |
| `shared/rpc.ts` | The RPC contracts (Zod) |
| `shared/model.ts` | Lanes, labels and other display values |
| `index.client.tsx` | Registers the panel, the overview, `/docket` and the ⌘K items |
| `client/panel.tsx` | The Docket panel |
| `client/finding.tsx` | One finding in full, with the decide controls |
| `client/overview.tsx` | The sidebar overview |
| `test/runner.test.ts` | Runner tests against a fake Paseo API |
