import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openCodeNativeRunner as runner } from '../dist-electron/providers/opencode/native-runner.js'

// Exercises the built adapter, including its real database worker and version subprocess.
const root = await mkdtemp(join(tmpdir(), 'mako-native-runtime-'))
try {
  const binary = join(root, 'renamed-agent')
  await writeFile(binary, '#!/bin/sh\nprintf "opencode v2.0.1\\n"\n')
  await chmod(binary, 0o700)
  const current = join(root, 'custom.db')
  const legacy = join(root, 'legacy.db')
  for (const [path, v2] of [[current, true], [legacy, false]]) {
    const db = new DatabaseSync(path)
    try {
      db.exec('CREATE TABLE session (id TEXT PRIMARY KEY); INSERT INTO session VALUES (\'ses_fixture\');')
      if (v2) db.exec('CREATE TABLE session_message (id TEXT, session_id TEXT, data TEXT)')
      else db.exec('CREATE TABLE message (id TEXT, session_id TEXT, data TEXT); CREATE TABLE part (id TEXT, session_id TEXT, data TEXT)')
    } finally { db.close() }
  }
  const env = { ...process.env, OPENCODE_BIN_PATH: binary, OPENCODE_DB: current }
  const settings = { model: 'provider/model', options: { effort: 'high' } }
  const fresh = await runner.fresh('hello', settings, env)
  assert.equal(fresh.command, binary)
  assert.deepEqual(fresh.args, ['run', '--auto', '--model', 'provider/model#high', 'hello'])
  const resumed = await runner.resume('ses_fixture', 'next', { ...settings, nativePath: `${current}#ses_fixture` }, env)
  assert.deepEqual(resumed.args, ['run', '--auto', '--session', 'ses_fixture', '--model', 'provider/model#high', 'next'])
  await assert.rejects(runner.resume('ses_fixture', 'next', { nativePath: `${legacy}#ses_fixture` }, env), /different native store/)
  await assert.rejects(runner.resume('ses_fixture', 'next', { nativePath: `${legacy}#ses_fixture` }, { ...env, OPENCODE_DB: legacy }), /requires v1/)
  await writeFile(binary, '#!/bin/sh\nprintf "1.4.11\\n"\n')
  const v1 = await runner.resume('ses_fixture', 'next', { ...settings, nativePath: `${legacy}#ses_fixture` }, { ...env, OPENCODE_DB: legacy })
  assert.deepEqual(v1.args, ['run', '--session', 'ses_fixture', '--model', 'provider/model', '--variant', 'high', 'next'])
  await assert.rejects(runner.resume('ses_fixture', 'next', { nativePath: `${current}#ses_fixture` }, env), /requires v2/)
  await assert.rejects(runner.resume('ses_missing', 'next', { nativePath: `${legacy}#ses_missing` }, { ...env, OPENCODE_DB: legacy }), /could not be resolved/)
  console.log('Built OpenCode headless adapter: native v1/v2 store resolution, account environment, renamed binary, generation-specific arguments, missing/mismatched source refusal')
} finally { await rm(root, { recursive: true, force: true }) }
