// Opt-in native test. Only disposable workspaces and sessions are changed.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { openCodeAcpSource } from '../dist-electron/providers/opencode/acp.js'

const root = await mkdtemp(join(tmpdir(), 'mako-provider-e2e-native-presets-'))
const result = { root, cases: [] }
try {
  for (const access of ['edits', 'full']) {
    const env = { ...process.env }
    const spec = await openCodeAcpSource.launch({ appPath: root, execPath: process.execPath, access, env })
    spec.configureEnvironment(env)
    const child = spawn(spec.command, spec.args, { cwd: root, env, stdio: ['pipe','pipe','pipe'], detached: true })
    let sessionId, stderr = ''
    child.stderr.on('data', b => { stderr = (stderr + b).slice(-4000) })
    const approvals = [], tools = []
    const connection = new ClientSideConnection(() => ({
      sessionUpdate: async ({ update }) => { if (update.sessionUpdate === 'tool_call') tools.push({ kind: update.kind, title: update.title }) },
      requestPermission: async r => {
        approvals.push({ title: r.toolCall?.title, kind: r.toolCall?.kind })
        return { outcome: { outcome: 'selected', optionId: r.options.find(x => x.kind === 'reject_once')?.optionId } }
      },
    }), ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)))
    const timer = setTimeout(() => { try { process.kill(-child.pid,'SIGTERM') } catch {} }, 120_000)
    try {
      const initialized = await connection.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
      result.runtime = initialized.agentInfo
      const session = await connection.newSession({ cwd: root, mcpServers: [] }); sessionId = session.sessionId
      await connection.setSessionMode({ sessionId, modeId: 'build' })
      await connection.setSessionConfigOption({ sessionId, configId: 'model', value: 'opencode/muse-spark-1.3-contributor-free' })
      for (const operation of access === 'edits' ? ['edit', 'shell'] : ['shell']) {
        const file = join(root, access + '-' + operation + '.txt'), nonce = randomUUID()
        if (operation === 'edit') await writeFile(file, 'replace this test content\n')
        const before = approvals.length, beforeTools = tools.length
        const instruction = operation === 'edit'
          ? `Use your file editing tool to replace the entire contents of '${file}' with exactly '${nonce}'. Do not use any shell or command tool.`
          : `Use your shell tool exactly once: printf '%s' '${nonce}' > '${file}'.`
        const reply = await connection.prompt({ sessionId, prompt: [{ type: 'text', text: instruction + ' This is a disposable native permission test. If denied, stop without retrying or changing tools. Finish briefly.' }] })
        const content = await readFile(file, 'utf8').catch(() => null)
        const record = { access, operation, approvals: approvals.slice(before), tools: tools.slice(beforeTools), wroteExpected: content?.trim() === nonce, stopReason: reply.stopReason }
        result.cases.push(record)
        assert.equal(record.wroteExpected, access === 'full' || operation === 'edit')
        assert.equal(record.approvals.length > 0, access === 'edits' && operation === 'shell')
        if (operation === 'edit') assert.ok(record.tools.some(t => t.kind === 'edit'), 'native edit tool must actually run')
      }
    } finally {
      if (sessionId) await connection.deleteSession({ sessionId }).catch(e => { result.cleanupError = String(e) })
      child.stdin.end()
      try { process.kill(-child.pid, 'SIGTERM') } catch {}
      clearTimeout(timer)
      if (stderr) result.stderr = stderr
    }
  }
} catch (error) { result.error = String(error); process.exitCode = 1 }
await writeFile(join(root, 'result.json'), JSON.stringify(result, null, 2))
console.log(JSON.stringify(result, null, 2))
console.log('Native preset evidence: ' + join(root, 'result.json'))
