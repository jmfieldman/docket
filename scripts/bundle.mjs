// Bundles the CLI and its dependencies into one file the Claude Code plugin
// can run without node_modules.
import { buildSync } from 'esbuild'

buildSync({
  entryPoints: ['src/cli.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: 'plugin/bin/docket.cjs',
  legalComments: 'none',
  logLevel: 'warning'
})
