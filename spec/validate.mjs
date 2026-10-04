// Validates the examples under spec/examples against the v1 schemas, plus the
// cross-file rules in SPEC.md that a JSON Schema cannot express.
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { parse as parseYaml } from 'yaml'

const here = dirname(fileURLToPath(import.meta.url))
const schemaDir = join(here, 'schema')
const ajv = new Ajv2020({ allErrors: true, strict: true })
addFormats(ajv)
for (const file of readdirSync(schemaDir)) {
  ajv.addSchema(JSON.parse(readFileSync(join(schemaDir, file), 'utf8')), file)
}

const CLOSED = new Set(['completed', 'acknowledged', 'deferred', 'resolved_externally'])
const DEFERRAL_SECTIONS = [
  'Summary',
  'Background',
  'Why it was deferred',
  'Where the code is',
  'Recommended approach',
  'Done when',
  'Original review comments'
]

let failures = 0
function fail(label, message) {
  failures++
  console.error(`FAIL ${label}: ${message}`)
}
function check(schema, label, value) {
  const validate = ajv.getSchema(schema)
  if (validate(value)) return true
  for (const error of validate.errors) fail(label, `${error.instancePath || '/'} ${error.message}`)
  return false
}
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))

function validateWorktree(dir, name) {
  check('unit.schema.json', `${name}/unit.json`, readJson(join(dir, 'unit.json')))
  const sources = readJson(join(dir, 'sources.json'))
  check('sources.schema.json', `${name}/sources.json`, sources)

  const findings = new Map()
  const findingsDir = join(dir, 'findings')
  for (const file of readdirSync(findingsDir)) {
    const finding = readJson(join(findingsDir, file))
    const label = `${name}/findings/${file}`
    if (!check('finding.schema.json', label, finding)) continue
    if (`${finding.id}.json` !== file) fail(label, `id ${finding.id} does not match the file name`)
    findings.set(finding.id, { finding, label })
  }

  for (const { finding, label } of findings.values()) {
    const closed = CLOSED.has(finding.state)
    if (closed && !finding.resolution) fail(label, `closed state ${finding.state} needs a resolution`)
    if (!closed && finding.resolution) fail(label, `open state ${finding.state} must not have a resolution`)
    if (closed && finding.resolution && finding.resolution.outcome !== finding.state) {
      fail(label, `resolution.outcome ${finding.resolution.outcome} does not match state ${finding.state}`)
    }
    if (closed && finding.stale) fail(label, 'a closed finding must not carry the stale flag')

    finding.iterations.forEach((iteration, index) => {
      if (iteration.n !== index + 1) fail(label, `iteration ${index + 1} has n=${iteration.n}`)
      for (const other of iteration.alsoResolves ?? []) {
        const target = findings.get(other)?.finding
        const by = target?.resolution?.resolvedBy
        if (!target) fail(label, `alsoResolves names missing finding ${other}`)
        else if (by?.findingId !== finding.id || by?.iteration !== iteration.n) {
          fail(label, `${other} does not point back with resolvedBy ${finding.id}#${iteration.n}`)
        }
      }
    })

    const by = finding.resolution?.resolvedBy
    if (by && !findings.get(by.findingId)?.finding.iterations[by.iteration - 1]) {
      fail(label, `resolvedBy points at missing iteration ${by.findingId}#${by.iteration}`)
    }

    for (const ref of finding.sources) {
      const source = sources.sources[ref.sourceId]
      if (!source) fail(label, `source ${ref.sourceId} is not in sources.json`)
      else if (!source.findingIds.includes(finding.id)) fail(label, `sources.json ${ref.sourceId} does not list ${finding.id}`)
    }
  }

  const lines = readFileSync(join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean)
  lines.forEach((line, index) => {
    const event = JSON.parse(line)
    const label = `${name}/events.jsonl:${index + 1}`
    check('event.schema.json', label, event)
    if (event.findingId && !findings.has(event.findingId)) fail(label, `unknown finding ${event.findingId}`)
  })
}

function validateDeferral(path, label, archived) {
  const text = readFileSync(path, 'utf8')
  const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!match) return fail(label, 'missing YAML frontmatter')
  const frontmatter = parseYaml(match[1])
  if (!check('deferral.schema.json', label, frontmatter)) return
  if (`${frontmatter.id}.md` !== basename(path)) fail(label, `id ${frontmatter.id} does not match the file name`)
  const closed = frontmatter.status === 'done' || frontmatter.status === 'dropped'
  if (closed !== archived) fail(label, `status ${frontmatter.status} belongs ${closed ? 'in' : 'outside'} archive/`)

  const headings = [...match[2].matchAll(/^## (.+)$/gm)].map((m) => m[1].trim())
  if (JSON.stringify(headings) !== JSON.stringify(DEFERRAL_SECTIONS)) {
    fail(label, `body sections must be, in order: ${DEFERRAL_SECTIONS.join(' / ')}`)
  }
}

function validateDeferrals(dir, name) {
  for (const file of readdirSync(dir)) {
    const path = join(dir, file)
    if (file === 'archive' && statSync(path).isDirectory()) {
      for (const archivedFile of readdirSync(path)) {
        validateDeferral(join(path, archivedFile), `${name}/archive/${archivedFile}`, true)
      }
    } else if (file.endsWith('.md')) {
      validateDeferral(path, `${name}/${file}`, false)
    }
  }
}

const examplesDir = join(here, 'examples')
for (const name of readdirSync(examplesDir)) {
  const dir = join(examplesDir, name)
  if (existsSync(join(dir, 'unit.json'))) validateWorktree(dir, name)
  else if (name === 'deferrals') validateDeferrals(dir, name)
}

if (failures) {
  console.error(`${failures} problem(s) found`)
  process.exit(1)
}
console.log('all examples valid')
