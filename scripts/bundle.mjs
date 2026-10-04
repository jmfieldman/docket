// Bundles the CLI and the worker library with their dependencies, so the
// Claude Code plugin and the Orca plugin run without node_modules.
import { copyFileSync } from 'node:fs'
import { buildSync } from 'esbuild'

const common = { bundle: true, platform: 'node', target: 'node22', format: 'cjs', legalComments: 'none', logLevel: 'warning' }
buildSync({ ...common, entryPoints: ['src/cli.ts'], outfile: 'plugin/bin/docket.cjs' })
buildSync({ ...common, entryPoints: ['src/lib.ts'], outfile: 'orca-plugin/docket-lib.cjs' })
copyFileSync('plugin/bin/docket.cjs', 'orca-plugin/docket.cjs')
copyFileSync('ui/index.html', 'orca-plugin/panel.html')
