import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'
import { catalogCodeIdentity, catalogSharingIdentity } from '../dist/catalog-identity.js'
import { SessionCatalog } from '../dist/catalog.js'
import { serveCatalog } from '../dist/daemon.js'

const root = await mkdtemp(join(tmpdir(),'mako-catalog-sharing-'))
try {
  const first=join(root,'first'),second=join(root,'second')
  await mkdir(first)
  await writeFile(join(first,'reader.js'),'export const reader = 1\n')
  await cp(first,second,{recursive:true})
  const code=await catalogCodeIdentity(first)
  assert.equal(await catalogCodeIdentity(second),code,'identical code at another installation path shares identity')
  await writeFile(join(second,'reader.js'),'export const reader = 2\n')
  assert.notEqual(await catalogCodeIdentity(second),code,'a changed reader invalidates sharing')
  await symlink(join(first,'reader.js'),join(second,'linked.js'))
  await assert.rejects(catalogCodeIdentity(second), /regular packaged files/, 'an untracked reader symlink cannot claim compatibility')
  const packaged=join(root,'packaged')
  await mkdir(join(packaged,'node_modules'),{recursive:true})
  await cp(new URL('../dist/',import.meta.url),join(packaged,'dist'),{recursive:true})
  await cp(new URL('../package.json',import.meta.url),join(packaged,'package.json'))
  const zodRoot=dirname(fileURLToPath(import.meta.resolve('zod/package.json')))
  await cp(zodRoot,join(packaged,'node_modules/zod'),{recursive:true})
  const metadataPath=join(packaged,'node_modules/zod/package.json')
  const metadata=JSON.parse(await readFile(metadataPath,'utf8'))
  delete metadata.scripts;delete metadata.keywords;delete metadata.bugs
  await writeFile(metadataPath,JSON.stringify(metadata))
  const packagedIdentity=await import(pathToFileURL(join(packaged,'dist/catalog-identity.js')))
  const original=await catalogCodeIdentity()
  assert.equal(await packagedIdentity.catalogCodeIdentity(),original,'packaging metadata cleanup must not split identical readers')
  await writeFile(join(packaged,'node_modules/zod/v4/core/core.js'),'// changed dependency implementation\n',{flag:'a'})
  assert.notEqual(await packagedIdentity.catalogCodeIdentity(),original,'dependency code changes invalidate compatibility')
  const scope={code,archivePath:join(root,'archive'),providers:[{harness:'claude',roots:[join(root,'account-a')]},{harness:'codex',roots:[join(root,'codex')]}]}
  const identity=catalogSharingIdentity(scope)
  assert.equal(catalogSharingIdentity({...scope,providers:[...scope.providers].reverse()}),identity,'registration order is not a new data scope')
  assert.notEqual(catalogSharingIdentity({...scope,providers:[{harness:'claude',roots:[join(root,'account-b')]}]}),identity,'accounts do not share')
  assert.notEqual(catalogSharingIdentity({...scope,archivePath:join(root,'other-archive')}),identity,'archives do not share')
  assert.notEqual(catalogSharingIdentity({...scope,code:'changed'}),identity,'readers do not share after a code change')

  // Two independent host processes consume one real catalog service. Their
  // list calls must not create another native discovery pass or subscription.
  let discoveries=0
  const catalog=new SessionCatalog([{harness:'codex',displayName:'fixture',roots:()=>[],discover:async()=>{discoveries++;return []},owns:()=>false,peek:async()=>null,read:async()=>{throw Error('not used')}}])
  await catalog.scan()
  const socket=join(root,'catalog.sock')
  const server=await serveCatalog(catalog,socket,undefined,{catalogIdentity:identity})
  const start=performance.now()
  const source=`import {connectDaemon} from ${JSON.stringify(new URL('../dist/daemon.js',import.meta.url).href)};const client=await connectDaemon(${JSON.stringify(socket)});for(let i=0;i<20;i++)await client.list();console.log(JSON.stringify({identity:client.stats.catalogIdentity,pid:client.stats.pid}));client.close();`
  async function client() {
    const child=spawn(process.execPath,['--input-type=module','-e',source],{stdio:['ignore','pipe','pipe']})
    let output='',errors=''
    child.stdout.on('data',chunk=>{output+=chunk})
    child.stderr.on('data',chunk=>{errors+=chunk})
    const exit=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve)})
    assert.equal(exit,0,errors)
    return JSON.parse(output)
  }
  try {
    const clients=await Promise.all([client(),client()])
    assert.ok(clients.every(c=>c.identity===identity&&c.pid===process.pid),'both hosts attach to the same identified catalog')
    assert.equal(discoveries,1,'forty reads across two hosts perform only the original discovery')
    console.log(JSON.stringify({clients:clients.length,reads:40,discoveries,elapsedMs:Math.round(performance.now()-start)}))
  } finally {
    await new Promise(resolve=>server.close(resolve))
    await catalog.stop()
  }
} finally { await rm(root,{recursive:true,force:true}) }
