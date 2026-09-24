import assert from 'node:assert/strict'
import { spawn, fork } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { build } from 'esbuild'
import { connectDaemon } from '../packages/sessions/dist/index.js'

if (process.argv[2] === 'client') {
  const client = process.argv[4]
    ? await (await import(process.argv[4])).connectOnDemandCatalog(new AbortController().signal)
    : await connectDaemon(process.argv[3], 1000)
  assert.ok(client, 'production host connector finds its reader')
  process.send({ ready: true, stats: client.stats })
  process.on('message', async ({ id, op, path }) => {
    try {
      let value
      if (op === 'list') value = await client.list()
      if (op === 'page') value = await client.page(path, undefined, 10, { maxChars: 65536, toolOutputChars: 512 })
      if (op === 'follow') { await client.follow(path, 0); value = true }
      if (op === 'stats') value = await client.refresh()
      process.send({ id, value })
    } catch (error) { process.send({ id, error: String(error) }) }
  })
  process.on('disconnect', () => { client.close(); process.exit(0) })
} else {
  const native = process.argv.includes('--native')
  const root = await mkdtemp(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'mako-demand-'))
  const home = native ? homedir() : join(root, 'home')
  if (!native) {
    await mkdir(join(home, '.mako'), { recursive: true })
    await writeFile(join(home, '.mako/syncd-login-optout'), '')
    const store = join(home, '.codex/sessions/2026/09/24')
    await mkdir(store, { recursive: true })
    await writeFile(join(store, 'rollout-fixture.jsonl'), [
      { type: 'session_meta', payload: { id: 'fixture', cwd: root } },
      { type: 'turn_context', payload: { model: 'fixture-model' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{type:'input_text',text:'Fixture history'}] } },
    ].map(row => JSON.stringify(row)).join('\n')+'\n')
  }
  const env = { ...process.env, HOME: home, ELECTRON_RUN_AS_NODE: '1' }
  if (!native) for (const name of ['CLAUDE_CONFIG_DIR', 'MAKO_CURSOR_SDK_ROOT', 'XDG_DATA_HOME', 'OPENCODE_DB']) delete env[name]
  const daemon = resolve('packages/sessions/dist/daemon-main.js')
  // Resolve the same root/runtime scope in the prospective reader's environment.
  const identityProcess = spawn(process.execPath, ['--input-type=module', '-e', `import {defaultCatalogIdentity,onDemandCatalogPaths} from ${JSON.stringify(new URL('../packages/sessions/dist/index.js', import.meta.url).href)};const identity=await defaultCatalogIdentity(${JSON.stringify(join(home,'.mako/archive'))});console.log(JSON.stringify({identity,...onDemandCatalogPaths(identity)}))`], { env, stdio: ['ignore', 'pipe', 'inherit'] })
  let identityOutput = ''
  identityProcess.stdout.on('data', chunk => { identityOutput += chunk })
  assert.equal((await once(identityProcess, 'exit'))[0], 0)
  const paths = JSON.parse(identityOutput)
  const connector = join(root,'connector.mjs')
  await build({entryPoints:['electron/catalog-connection.ts'],bundle:true,platform:'node',format:'esm',outfile:connector,plugins:[{
    name:'host-boundary',setup(b){
      b.onResolve({filter:/^@mako\/sessions$/},()=>({path:resolve('packages/sessions/dist/index.js'),external:true}))
      b.onResolve({filter:/^\.\/daemon-login\.js$/},()=>({path:'daemon-path',namespace:'fixture'}))
      b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:`export const daemonScript=()=>${JSON.stringify(daemon)}`,loader:'js'}))
    }
  }]})
  const optOut = await readFile(join(home, '.mako/syncd-login-optout'))
  const servers = [], clients = [], logs = []
  const startServer = () => {
    const child = spawn(process.execPath, ['--expose-gc', '--max-old-space-size=768', daemon, '--on-demand'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    servers.push(child)
    for (const pipe of [child.stdout, child.stderr]) pipe.on('data', chunk => logs.push(chunk.toString()))
    return child
  }
  const waitServer = async () => {
    const deadline = Date.now()+15000
    while (Date.now()<deadline) {
      const client = await connectDaemon(paths.socket, 500).catch(()=>null)
      if (client) return client
      await delay(50)
    }
    throw Error('Reader did not start: '+logs.join(''))
  }
  const newClient = async () => {
    const child = fork(fileURLToPath(import.meta.url), ['client', paths.socket, connector], { env, stdio: ['ignore','ignore','inherit','ipc'] })
    clients.push(child)
    const [ready] = await once(child, 'message')
    assert.ok(ready.ready)
    let sequence = 0
    const request = (op, path) => new Promise((resolve, reject) => {
      const id = ++sequence
      const timer = setTimeout(() => { child.off('message', reply); reject(Error('Client timed out')) }, 30000)
      const reply = result => {
        if (result.id !== id) return
        clearTimeout(timer);child.off('message',reply)
        if (result.error) reject(Error(result.error));else resolve(result.value)
      }
      child.on('message',reply);child.send({id,op,path})
    })
    return { child, ready, request }
  }
  const report = { root, native, rows: [] }
  let observer
  try {
    // Claim happens before scan, so concurrent launches do not duplicate metadata work.
    startServer();startServer()
    observer = await waitServer()
    const ownerPid = observer.stats.pid
    const [first, second] = await Promise.all([newClient(),newClient()])
    assert.equal(first.ready.stats.pid, ownerPid);assert.equal(second.ready.stats.pid, ownerPid)
    assert.equal(first.ready.stats.catalogIdentity, paths.identity)
    const [a,b] = await Promise.all([first.request('list'),second.request('list')])
    assert.deepEqual(a,b)
    const before = await observer.refresh()
    assert.equal(before.fullScans,1)
    const expected = native ? ['claude','codex','cursor','grok','devin','opencode'] : ['codex']
    for (const harness of expected) {
      const candidates=a.filter(ref=>ref.harness===harness&&!ref.archived&&ref.bytes>0).sort((x,y)=>x.bytes-y.bytes)
      let page
      for (const ref of candidates.slice(0,20)) {
        page = await first.request('page',ref.path)
        if (page?.entries.length) break
      }
      assert.ok(page?.entries.length, harness+' native history')
      report.rows.push({harness,entries:page.entries.length})
    }
    const path=a.find(ref=>!ref.archived).path
    await first.request('follow',path);await second.request('follow',path)
    const following=await observer.refresh()
    assert.ok(following.observations>0)
    first.child.disconnect()
    await once(first.child,'exit')
    const oneLeft=await second.request('stats')
    assert.equal(oneLeft.observations,following.observations,'one follower remains on the same subscriptions')
    assert.equal(oneLeft.fullScans,before.fullScans,'joining/reading/following does not scan again')
    report.shared={ownerPid,sessions:a.length,before,following,oneLeft}
    second.child.disconnect();await once(second.child,'exit')
    observer.close()
    const disconnectedAt=performance.now()
    const owner=servers.find(p=>p.pid===ownerPid)
    assert.ok(owner,'do not retire a preexisting user reader')
    await Promise.race([once(owner,'exit'),delay(native ? 60000 : 14000,undefined,{ref:false}).then(()=>{throw Error('Reader did not exit after last client')})])
    report.idleAndDrainMs=Math.round(performance.now()-disconnectedAt)
    const peer=servers.find(p=>p.pid!==ownerPid)
    assert.equal(peer.exitCode,0)
    // The next host reuses the same persistent metadata cache, without login registration.
    const launcher = await newClient();observer=await waitServer()
    assert.notEqual(observer.stats.pid,ownerPid)
    const restartedRefs = await observer.list()
    if (!native) assert.equal(restartedRefs.length,a.length)
    else for (const harness of expected) assert.ok(restartedRefs.some(ref=>ref.harness===harness))
    report.restarted=await observer.refresh()
    observer.close()
    launcher.child.disconnect();await once(launcher.child,'exit')
    const deadline = Date.now() + (native ? 60000 : 14000)
    while (Date.now() < deadline) {
      try { process.kill(report.restarted.pid,0) } catch { break }
      await delay(100)
    }
    assert.throws(()=>process.kill(report.restarted.pid,0), 'connector-launched reader exits after its last host')
    assert.deepEqual(await readFile(join(home,'.mako/syncd-login-optout')),optOut)
    report.outcome='passed'
  } finally {
    observer?.close()
    for (const child of clients) if(child.connected)child.disconnect()
    for (const child of servers) if(child.exitCode===null)child.kill('SIGTERM')
    await writeFile(join(root,'result.json'),JSON.stringify(report,null,2)+'\n')
    await writeFile(join(root,'reader.log'),logs.join(''))
    if (!native) await rm(home,{recursive:true,force:true})
    console.log('On-demand catalog evidence: '+join(root,'result.json'))
  }
}
