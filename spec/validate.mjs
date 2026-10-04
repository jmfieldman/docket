// Validates every example docket under spec/examples against the v1 schemas.
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

const here = dirname(fileURLToPath(import.meta.url))
const schemaDir = join(here, 'schema')
const ajv = new Ajv2020({ allErrors: true, strict: true })
addFormats(ajv)
for (const file of readdirSync(schemaDir)) {
  ajv.addSchema(JSON.parse(readFileSync(join(schemaDir, file), 'utf8')), file)
}

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))
let failures = 0
function check(schema, label, value) {
  const validate = ajv.getSchema(schema)
  if (validate(value)) return
  failures++
  console.error(`FAIL ${label}`)
  for (const error of validate.errors) console.error(`  ${error.instancePath || '/'} ${error.message}`)
}

const examplesDir = join(here, 'examples')
for (const name of readdirSync(examplesDir)) {
  const dir = join(examplesDir, name)
  check('unit.schema.json', `${name}/unit.json`, readJson(join(dir, 'unit.json')))
  check('sources.schema.json', `${name}/sources.json`, readJson(join(dir, 'sources.json')))
  const findingsDir = join(dir, 'findings')
  for (const file of existsSync(findingsDir) ? readdirSync(findingsDir) : []) {
    check('finding.schema.json', `${name}/findings/${file}`, readJson(join(findingsDir, file)))
  }
  const lines = readFileSync(join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean)
  lines.forEach((line, index) => check('event.schema.json', `${name}/events.jsonl:${index + 1}`, JSON.parse(line)))
}

if (failures) {
  console.error(`${failures} file(s) failed validation`)
  process.exit(1)
}
console.log('all examples valid')
