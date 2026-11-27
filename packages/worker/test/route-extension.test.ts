import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

const router = new URL('../pi-support/codex-cursor-fallback.ts', import.meta.url)
const loader = `
  import { registerHooks } from 'node:module';
  // The Pi install supplies these stream helpers. No stream should run at load time.
  registerHooks({ resolve(specifier, context, next) {
    if (specifier !== '@earendil-works/pi-ai') return next(specifier, context);
    return { shortCircuit: true, url: 'data:text/javascript,export let clampThinkingLevel, createAssistantMessageEventStream' };
  } });
  await import(${JSON.stringify(router.href)});
`

function load(tiers: string | undefined) {
  return spawnSync(process.execPath, ['--input-type=module', '--eval', loader], { encoding: 'utf8', env: tiers === undefined ? {} : { PI_FALLBACK_TIERS: tiers } })
}

test('the route extension fails to load without a non-empty array of well-formed routes', () => {
  const route = { label: 'Example', provider: 'cursor', model: 'example' }
  for (const input of [undefined, '{', '{}', '[]', '[null]', '[{}]', JSON.stringify([{ ...route, model: 1 }]), JSON.stringify([{ ...route, extra: true }])]) {
    const result = load(input)
    assert.equal(result.status, 1, `should reject ${input}`)
    assert.match(result.stderr, /PI_FALLBACK_TIERS must be a non-empty JSON array of routes/)
  }
})

test('the route extension fails when a route has an empty label, model or provider', () => {
  const valid = { label: 'Cursor Grok', provider: 'cursor', model: 'cursor-grok-4.6-high' }
  for (const input of [
    JSON.stringify([{ ...valid, model: '' }]),
    JSON.stringify([{ ...valid, provider: '' }]),
    JSON.stringify([{ ...valid, label: '' }]),
    JSON.stringify([{ ...valid, model: '' }, valid]),
  ]) {
    const result = load(input)
    assert.equal(result.status, 1, `should reject ${input}`)
    assert.match(result.stderr, /PI_FALLBACK_TIERS must be a non-empty JSON array of routes/)
  }
})
