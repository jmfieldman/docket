// Bundles docket with its dependencies, so each surface runs without
// node_modules:
// - plugin/bin/docket.cjs: the CLI, for the Claude Code plugin.
// - paseo/server/docket-api.cjs: the action layer (src/api.ts) as a library,
//   for the Paseo plugin's daemon subprocess. Paseo compiles a plugin only from
//   files inside its own directory, so the library lives there.
import { buildSync } from 'esbuild'

const common = { bundle: true, platform: 'node', target: 'node22', format: 'cjs', legalComments: 'none', logLevel: 'warning' }

buildSync({ ...common, entryPoints: ['src/cli.ts'], outfile: 'plugin/bin/docket.cjs' })
buildSync({ ...common, entryPoints: ['src/api.ts'], outfile: 'paseo/server/docket-api.cjs' })
