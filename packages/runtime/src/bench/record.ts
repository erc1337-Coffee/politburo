type Field<T> = {
  schema: Record<string, unknown>
  accepts(value: unknown): value is T
}

type Value<F> = F extends Field<infer T> ? T : never

function field<T>(schema: Field<T>['schema'], check: (value: unknown) => boolean): Field<T> {
  return { schema, accepts: (value): value is T => check(value) }
}

function object<F extends Record<string, Field<unknown>>>(fields: F, optional?: keyof F) {
  const entries = Object.entries(fields)
  return field<{ [K in keyof F]: Value<F[K]> }>({
    type: 'object', properties: Object.fromEntries(entries.map(([key, f]) => [key, f.schema])),
    required: Object.keys(fields).filter((key) => key !== optional), additionalProperties: false,
  }, (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const data = value as Record<string, unknown>
    return Reflect.ownKeys(data).every((key) => Object.hasOwn(fields, key)) &&
      entries.every(([key, f]) => Object.hasOwn(data, key) ? f.accepts(data[key]) : key === optional)
  })
}

function nullable<T>(f: Field<T>) {
  const { type, enum: choices } = f.schema
  return field<T | null>(Array.isArray(choices) ? { enum: [...choices, null] } : { ...f.schema, type: [type, 'null'] },
    (value) => value === null || f.accepts(value))
}

function choices<const T extends readonly (string | number)[]>(...values: T) {
  return field<T[number]>({ enum: values }, (value) => values.includes(value as T[number]))
}

function text(test: (value: string) => boolean, schema = {}) {
  return field<string>({ type: 'string', maxLength: 200, ...schema }, (value) =>
    typeof value === 'string' && value.length <= 200 && value.isWellFormed() && test(value))
}

// Board schemas are structural (no patterns); check names and exact timestamps here.
const name = text((s) => /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]*$/.test(s), { minLength: 1 })
const runId = text((s) => /^[a-zA-Z0-9][a-zA-Z0-9_.:-]*(?:~[1-9]\d*)?$/.test(s), { minLength: 1 })
const taskId = text((s) => /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]*(?:#\d+)?$/.test(s), { minLength: 1 })
const repo = text((s) => /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(s), { minLength: 3 })
const reason = text((s) => !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(s))
const command = text((s) => /^[a-zA-Z0-9_.:-]+(?: [a-zA-Z0-9_.:-]+)*$/.test(s), { minLength: 1 })
const timestamp = text((s) => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(s) &&
  Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s, { format: 'date-time' })
const count = field<number>({ type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  (n) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0)
const seconds = field<number>({ type: 'number', minimum: 0 }, (n) =>
  typeof n === 'number' && Number.isFinite(n) && n >= 0 && Number(n.toFixed(3)) === n)
const maybeCount = nullable(count)
const usage = {
  turns: maybeCount, toolCalls: maybeCount,
  tokens: object({ in: maybeCount, out: maybeCount, reasoning: maybeCount, cached: maybeCount }),
  costMicros: maybeCount,
}
const model = { provider: name, name }
const modelUsage = object({ ...model, ...usage })
const byModel = field<Value<typeof modelUsage>[]>({ type: 'array', items: modelUsage.schema }, (value) =>
  Array.isArray(value) && Reflect.ownKeys(value).length === value.length + 1 && [...value].every(modelUsage.accepts))
const sprites = object({ count, wallSeconds: seconds, activeSeconds: nullable(seconds) })
const fields = object({
  schema: choices('bench-run@1'), runId, level: choices('sprite', 'mob', 'task', 'pr', 'spawner'),
  parentId: nullable(runId), taskId: nullable(taskId), repo: nullable(repo),
  model: nullable(object(model)), byModel: nullable(byModel), thinking: nullable(name),
  startedAt: timestamp, endedAt: timestamp, wallSeconds: seconds, activeSeconds: nullable(seconds),
  ...usage, outcome: object({ state: choices('done', 'failed', 'blocked', 'canceled'), reason: nullable(reason) }),
  changes: nullable(object({ files: count, linesAdded: count, linesRemoved: count })), reviewRounds: maybeCount,
  check: object({ result: nullable(choices('pass', 'fail', 'not_run')), command: nullable(command) }),
  coverage: object({ tokens: choices('complete', 'partial', 'none') }),
  complexity: object({
    rating: nullable(object({ score: choices(1, 2, 3, 4, 5), size: choices('S', 'M', 'L'), reason, ratedBy: name, ratedAt: timestamp })),
    proxies: object({ files: maybeCount, lines: maybeCount, reviewRounds: maybeCount, failedChecks: maybeCount, retries: maybeCount }),
  }),
  // Null on a sprite; a roll-up's summary of its sprites.
  sprites: nullable(sprites),
})

// The fence already identifies the schema. Check the redundant payload tag in
// isBenchRun; a boolean here keeps the board definition within 64 subschemas.
export const benchRunSchema = {
  ...fields.schema, properties: { ...fields.schema.properties as Record<string, unknown>, schema: true },
}
export type BenchRun = Value<typeof fields>

export function isBenchRun(value: unknown): value is BenchRun {
  return fields.accepts(value) && (value.level === 'sprite'
    ? value.byModel === null && value.sprites === null : value.model === null && value.sprites !== null && value.byModel !== null)
}
