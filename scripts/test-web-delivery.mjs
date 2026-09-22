import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import { preview } from 'vite'
import { webHostProxy } from '../electron/web-dev-proxy.mjs'
import { invokeRuntime } from '../dist-electron/runtime-connection.js'

const root = await mkdtemp(join(tmpdir(), 'mako-browser-delivery-'))
const socket = join(root, 'host.sock')
const requests = new Map()
const streams = new Set()
let dispatches = 0
let lostReply = false
const host = createServer(async (request, response) => {
  if (request.url === '/events') {
    response.writeHead(200, { 'content-type': 'application/x-ndjson' })
    response.write(JSON.stringify({ channel: 'ready' }) + '\n')
    streams.add(response)
    response.on('close', () => streams.delete(response))
    return
  }
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const { channel, args } = JSON.parse(Buffer.concat(chunks).toString())
  const values = args.map(arg => arg.kind === 'absent' ? undefined : arg.value)
  let value
  if (channel === 'mako:live-prompt') {
    const [, id, text] = values
    if (!requests.has(id)) {
      dispatches++
      requests.set(id, { id, text, attachments: [], status: 'queued' })
      for (const stream of streams) stream.write(JSON.stringify({ channel: 'event', payload: { type: 'notice', level: 'info', message: text } }) + '\n')
    }
    if (!lostReply) { lostReply = true; response.destroy(); return }
    value = requests.get(id)
  } else if (channel === 'mako:live-snapshot') value = { requests: [...requests.values()] }
  else throw new Error('Unexpected fixture method ' + channel)
  response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, value }))
})
await new Promise(resolve => host.listen(socket, resolve))
await mkdir(join(root, 'dist'))
await build({ entryPoints: ['src/dev/web-bridge.ts'], outfile: join(root, 'dist/bridge.js'), bundle: true, format: 'esm', platform: 'browser', define: { 'import.meta.env': '{}' } })
await build({ entryPoints: ['src/state/message-outbox.ts'], outfile: join(root, 'dist/outbox.js'), bundle: true, format: 'esm', platform: 'browser', tsconfig: 'tsconfig.app.json' })
await writeFile(join(root, 'dist/index.html'), `<title>Mako delivery fixture</title><script type="module">
import {installWebBridge} from './bridge.js';
import * as outbox from './outbox.js';
await installWebBridge(); window.outbox=outbox; window.events=[]; window.mako.onEvent(e=>events.push(e));
outbox.watchPendingMessages(async()=>{
 for(const command of outbox.pendingMessages()) {
  if(command.kind!=='prompt') continue;
  await window.mako.livePrompt(command.conversationId,command.requestId,command.text,command.attachments,command.tuning);
  outbox.settleMessage(command.requestId);
 }
});
window.ready=true;</script>`)
const gateway = await preview({ configFile: false, root, plugins: [webHostProxy(socket)], preview: { host: '127.0.0.1', port: 0 } })
const origin = gateway.resolvedUrls.local[0]
const electronScript = join(root, 'browser.cjs')
await writeFile(electronScript, `
const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict');
app.setPath('userData',${JSON.stringify(join(root, 'browser-data'))});
app.whenReady().then(async()=>{
 const windows=[];
 const wait=async(fn)=>{const end=Date.now()+10000;while(!await fn()){assert.ok(Date.now()<end,'browser condition timed out');await new Promise(r=>setTimeout(r,30));}};
 try {
  for(let i=0;i<2;i++) { const win=new BrowserWindow({show:false,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}});windows.push(win);await win.loadURL(${JSON.stringify(origin)});await wait(()=>win.webContents.executeJavaScript('Boolean(window.ready)')); }
  const [a,b]=windows.map(w=>w.webContents);
  await a.executeJavaScript('window.mako.livePrompt("conversation", "browser-first", "First browser message", [])');
  await wait(()=>b.executeJavaScript('events.some(e=>e.message==="First browser message")'));
  await b.executeJavaScript('window.mako.livePrompt("conversation", "browser-second", "Second browser message", [])');
  assert.equal((await a.executeJavaScript('window.mako.liveSnapshot("conversation")')).requests.length,2);
  await a.executeJavaScript('window.dispatchEvent(new PageTransitionEvent("pagehide",{persisted:true})); window.dispatchEvent(new PageTransitionEvent("pageshow",{persisted:true}))');
  await wait(()=>a.executeJavaScript('events.some(e=>e.type==="host-reconnected")'));
  await a.executeJavaScript('window.mako.livePrompt("conversation", "browser-restored", "After cached navigation", [])');
  await b.reload(); await wait(()=>b.executeJavaScript('Boolean(window.ready)'));
  assert.equal((await b.executeJavaScript('window.mako.liveSnapshot("conversation")')).requests.length,3);
  await a.executeJavaScript('window.outbox.saveMessage({kind:"prompt",conversationId:"conversation",requestId:"abandoned-tab",text:"Recover after sender closes",attachments:[]})');
  windows[0].destroy();
  await wait(()=>b.executeJavaScript('events.some(e=>e.message==="Recover after sender closes")'));
  await wait(()=>b.executeJavaScript('window.outbox.pendingMessages().length===0'));
  console.log('PASS: actual cross-window storage event recovers an abandoned command after sender closes');
  console.log('PASS: two real Chromium clients share sends/events; lost response replays one ID; cached-page lifecycle reconnects; reload sees shared history');
 } finally {windows.forEach(w=>{if(!w.isDestroyed())w.destroy()});app.quit();}
}).catch(error=>{console.error(error);app.exit(1)});
`)
try {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(createRequire(import.meta.url)('electron'), [electronScript], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk; process.stdout.write(chunk) })
  child.stderr.on('data', chunk => { output += chunk })
  const deadline = setTimeout(() => child.kill(), 40_000)
  const code = await new Promise(resolve => child.once('exit', resolve))
  clearTimeout(deadline)
  assert.equal(code, 0, output)
  assert.equal(dispatches, 4, 'lost response and abandoned tab did not cause duplicate provider dispatches')
  await invokeRuntime(socket, 'desktop-fixture', 'mako:live-prompt', ['conversation', 'desktop-next', 'Desktop continues', []])
  assert.equal(requests.size, 5)
  console.log('PASS: desktop socket transport continues the same host conversation')
} finally {
  for (const stream of streams) stream.destroy()
  await new Promise(resolve => gateway.httpServer.close(resolve))
  await new Promise(resolve => host.close(resolve))
  await rm(root, { recursive: true, force: true })
}
