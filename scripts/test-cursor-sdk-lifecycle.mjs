import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CursorSdkClient } from '../dist-electron/providers/cursor/sdk/client.js'

// Real SDK child, without auth or agent execution. A lost output reader used
// to recurse through uncaughtException -> protocol log -> EPIPE indefinitely.
for (const mode of ['broken-output', 'stdin-eof', 'explicit-close']) {
  const child = spawn(process.execPath, ['dist-electron/providers/cursor/sdk/child.js'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stderr.resume()
  const exited = once(child, 'exit')
  const deadline = setTimeout(() => child.kill('SIGKILL'), 8_000)
  try {
    const hello = once(child.stdout, 'data')
    child.stdin.write(JSON.stringify({ id: 1, method: 'hello' }) + '\n')
    await hello
    if (mode === 'broken-output') {
      child.stdout.destroy()
      child.stdin.write('invalid-json\n')
    } else if (mode === 'stdin-eof') child.stdin.end()
    else child.stdin.write(JSON.stringify({ id: 2, method: 'close' }) + '\n')
    const [code, signal] = await exited
    assert.equal(signal, null, `${mode} must exit without test cleanup`)
    assert.equal(code, mode === 'broken-output' ? 1 : 0)
    console.log(`${mode}: exited with ${code}`)
  } finally {
    clearTimeout(deadline)
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
}

const root = await mkdtemp(join(tmpdir(), 'mako-cursor-close-'))
const entry = join(root, 'silent.mjs')
await writeFile(entry, 'process.stdin.resume()\n')
const client = new CursorSdkClient({
  owner: 'cursor-close-fixture', cwd: root, env: {}, onEvent() {},
  execPath: process.execPath, entry, requestTimeoutMs: 10_000,
})
const deadline = setTimeout(() => client.kill(), 3_000)
try {
  const start = performance.now()
  await client.close(100)
  assert.ok(performance.now() - start < 2_000, 'close grace includes the unanswered close request')
  assert.equal(client.alive, false)
  console.log('unresponsive child: close grace bounds request and exit')
} finally {
  clearTimeout(deadline)
  client.kill()
  await rm(root, { recursive: true, force: true })
}
