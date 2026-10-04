// Docket worker for Orca. "Docket: Open" works on every Orca version: it
// starts the Docket UI server and opens the focused worktree in Orca's
// browser. "docket-api" serves the panel once Orca lets panels call their
// worker (plugin.command.invoke).
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const here = dirname(fileURLToPath(import.meta.url))
const lib = require('./docket-lib.cjs')

function asError(error) {
  return { error: { code: error?.code ?? 'error', message: error?.message ?? String(error) } }
}

export default function activate(orca) {
  orca.commands.register('docket-api', async (args) => {
    try {
      return await lib.handle(args ?? {})
    } catch (error) {
      return asError(error)
    }
  })

  orca.commands.register('docket-open', async () => {
    try {
      const context = await orca.host.call('workspace.readContext')
      const value = context && 'value' in context ? context.value : context
      const { candidates } = value ? lib.resolveContext(value.branch, value.displayName) : { candidates: [] }
      const result = await lib.openUi({ docketCli: join(here, 'docket.cjs'), path: candidates.length === 1 ? candidates[0].path : undefined })
      if (!result.opened) {
        await orca.host.call('notifications.show', { title: 'Docket', body: `Open ${result.url} in a browser.` })
      }
      return result
    } catch (error) {
      await orca.host.call('notifications.show', { title: 'Docket could not open', body: error?.message ?? String(error) })
      return asError(error)
    }
  })
}
