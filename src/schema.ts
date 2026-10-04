import { Ajv2020 } from 'ajv/dist/2020.js'
import addFormatsModule from 'ajv-formats'
import { DocketError } from './errors.ts'
import { SCHEMAS } from './schemas.generated.ts'

export type SchemaName = 'unit' | 'sources' | 'finding' | 'event' | 'deferral'

let ajv: Ajv2020 | null = null

function compiler(): Ajv2020 {
  if (ajv) return ajv
  ajv = new Ajv2020({ allErrors: true, strict: true })
  const addFormats = addFormatsModule as unknown as (instance: Ajv2020) => void
  addFormats(ajv)
  for (const [file, schema] of Object.entries(SCHEMAS)) ajv.addSchema(schema, file)
  return ajv
}

/** Throws a DocketError listing every schema violation. Every write goes through this. */
export function assertValid(name: SchemaName, value: unknown): void {
  const validate = compiler().getSchema(`${name}.schema.json`)
  if (!validate) throw new DocketError('schema_missing', `no schema named ${name}`)
  if (validate(value)) return
  const problems = (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ')
  throw new DocketError('schema_violation', `${name} write rejected: ${problems}`)
}
