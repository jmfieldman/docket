// Bundles the CLI with its dependencies, so the Claude Code plugin runs
// without node_modules.
import { buildSync } from 'esbuild'

buildSync({ bundle: true, platform: 'node', target: 'node22', format: 'cjs', legalComments: 'none', logLevel: 'warning', entryPoints: ['src/cli.ts'], outfile: 'plugin/bin/docket.cjs' })
