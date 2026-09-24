import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
if (!process.versions.electron) {
  const { createServer } = await import('vite')
  const root = await mkdtemp(join(tmpdir(), 'mako-reload-ui-'))
  const server = await createServer({ cacheDir: join(root, 'cache'), server: { host: '127.0.0.1', port: 0, hmr: false, watch: { ignored: ['**'] } } })
  await server.listen()
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'mako-reload-ui', main: fileURLToPath(import.meta.url) }))
  const env = { ...process.env, MAKO_RELOAD_ROOT: root, MAKO_RELOAD_URL: server.resolvedUrls.local[0] }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const child = spawn(resolve('node_modules/.bin/electron'), [root], { env, stdio: 'inherit' })
    process.exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)) })
  } finally { await server.close() }
} else {
  void review().catch(async error => { console.error(error); const { app } = await import('electron'); app.exit(1) })
}
async function review() {
  const { app, BrowserWindow } = await import('electron')
  app.setPath('userData', join(process.env.MAKO_RELOAD_ROOT, 'profile'))
  await app.whenReady()
  const window = new BrowserWindow({ width: 1200, height: 850, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  const page = window.webContents
  const evidence = resolve('docs/audits/2026-09-23/watcher-delivery-and-reload')
  await mkdir(evidence, { recursive: true })
  const evaluate = code => page.executeJavaScript(code)
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  async function until(code) {
    const end = Date.now() + 20000
    while (!await evaluate(code)) { assert.ok(Date.now() < end, code); await sleep(50) }
  }
  async function capture(name) {
    window.showInactive(); await sleep(350)
    await writeFile(join(evidence, name), (await page.capturePage()).toPNG())
  }
  const timeout = setTimeout(() => app.exit(1), 120000)
  const results = []
  try {
    await window.loadURL(process.env.MAKO_RELOAD_URL + 'scripts/reload-selection.html')
    await until("Boolean(document.querySelector('.composer-input'))")
    page.debugger.attach('1.3')
    for (const harness of ['claude', 'codex', 'cursor', 'grok', 'devin', 'opencode']) {
      await evaluate(`document.querySelector('[data-provider="${harness}"]').click()`)
      await until(`document.querySelector('.composer-input')?.placeholder.toLowerCase().includes('${harness}')`)
      const draft = `${harness}: keep this unsent draft through raw reload`
      await evaluate("document.querySelector('.composer-input').focus()")
      await page.debugger.sendCommand('Input.insertText', { text: draft })
      await until(`localStorage.getItem('mako.session-drafts.v1')?.includes(${JSON.stringify(draft)})`)
      const reload = new Promise(resolve => page.once('did-finish-load', resolve))
      page.reload(); await reload
      await until(`document.querySelector('[data-provider="${harness}"]')?.getAttribute('aria-pressed') === 'true' && document.querySelector('.composer-input')?.value === ${JSON.stringify(draft)}`)
      await capture(`${harness}-raw-reload.png`)
      results.push({ harness, selection: true, draft: true })
      console.log(`${harness}: raw reload restores selection and draft`)
    }
    await evaluate("document.querySelector('[data-new]').click()")
    for (let i = 0; i < 2; i++) {
      const reload = new Promise(resolve => page.once('did-finish-load', resolve)); page.reload(); await reload
      await until("Boolean(document.querySelector('[data-new]'))")
      assert.equal(await evaluate("Boolean(document.querySelector('[data-provider][aria-pressed=true]'))"), false, 'New stays selected across repeated reloads')
    }
    await writeFile(join(evidence, 'reload-ui.json'), JSON.stringify({ outcome: 'passed', results, newConversationRepeatedReload: true }, null, 2))
  } catch (error) { console.error(error); await capture('reload-failure.png'); process.exitCode = 1 }
  finally { clearTimeout(timeout); window.destroy(); app.exit(process.exitCode ?? 0) }
}
