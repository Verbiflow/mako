// Run from the repository root with node --import tsx docs/public-audits/2026-09-07/harness-defaults/reproduce.mjs
// Desired-behavior regressions for the original audit findings.
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveHarnessTuning } from "../../../../electron/harness-models.ts"
import { normalizeCodexModels, normalizeDevinModels } from "@mako/sessions/model-catalog"
import { codexNativeRunner } from '../../../../electron/providers/codex/native-runner.ts'
import { ProviderProfileCache } from '../../../../electron/provider-profile-cache.ts'

const catalog = normalizeCodexModels({ data: [{
  model: 'sample-model', isDefault: true, defaultReasoningEffort: 'medium',
  supportedReasoningEfforts: [{ reasoningEffort: 'medium' }],
  additionalSpeedTiers: ['fast'],
}] })
assert.equal(catalog.models[0].options.some(option => option.id === 'serviceTier'), true)
console.log('PASS: additionalSpeedTiers produces a speed control')

assert.notDeepEqual(
  codexNativeRunner.fresh('example', { options: { serviceTier: 'fast' } }),
  codexNativeRunner.fresh('example', { options: { serviceTier: 'default' } }),
)
console.log('PASS: native Codex speed and explicit reset emit different commands')

const devin = normalizeDevinModels({ families: [{
  slug: 'sample-family', family_label: 'Sample', is_default: true,
  variants: [
    { model_uid: 'sample-low', label: 'Low' },
    { model_uid: 'sample-high-fast', label: 'High Fast', is_default: true },
  ],
}] })
const profile = { id: 'devin', label: 'Devin', transport: 'acp', available: true, capabilities: [], ...devin }
assert.equal(resolveHarnessTuning(profile, { model: devin.defaultModel }).model, 'sample-high-fast')
console.log('PASS: Devin honors the declared default variant')

const directory = await mkdtemp(join(tmpdir(), 'mako-defaults-audit-'))
try {
  const path = join(directory, 'cache.json')
  const cachedProfile = { ...profile, models: [{ id: 'sample', label: 'Sample', options: [{
    kind: 'select', id: 'effort', label: 'Reasoning',
    values: [{ value: 'high', label: 'High', default: true, description: 'Provider description' }],
  }] }] }
  await new ProviderProfileCache(path).put('sample', cachedProfile)
  const restored = await new ProviderProfileCache(path).get('sample')
  assert.deepEqual(restored.models[0].options[0].values[0], { value: 'high', label: 'High', default: true, description: 'Provider description' })
  console.log('PASS: disk cache retains default and description')
} finally {
  await rm(directory, { recursive: true, force: true })
}
