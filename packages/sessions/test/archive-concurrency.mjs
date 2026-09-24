import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { DatabaseSync } from 'node:sqlite'
import { SessionArchive } from '../dist/archive.js'

const root = await mkdtemp(join(tmpdir(), 'mako-archive-concurrency-'))
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const ref = (revision = 'one', extra = {}) => ({ harness:'fixture',nativeId:'native',path:'/fixture/native',revision,bytes:100,...extra })
const thread = (revision='one', text=revision, extra={}) => ({ref:ref(revision,extra),entries:[{kind:'user',text}]})
const cases = []
const test = (name, run) => cases.push({name,run})
const capture = async (archive, value) => { archive.note(value.ref,async()=>value);await archive.flush() }

test('capture admission reads the revision index without fetching transcript rows', async(a,b,location)=>{
  const value=thread('indexed','x'.repeat(4*1024*1024))
  await capture(a,value)
  const db=new DatabaseSync(join(location,'archive.sqlite'),{readOnly:true})
  const prepare=DatabaseSync.prototype.prepare
  const plans=[]
  try {
    DatabaseSync.prototype.prepare=function(sql,...args) {
      if(/SELECT token, deleted, revision FROM archive_captures/.test(sql)) {
        plans.push(prepare.call(db,'EXPLAIN QUERY PLAN '+sql).all(value.ref.path))
      }
      return prepare.call(this,sql,...args)
    }
    let reads=0
    b.note(value.ref,async()=>{reads++;return value})
    await b.flush()
    assert.equal(reads,0,'another connection sees the committed revision without retranslating')
    assert.ok(plans.length>0,'observe the production admission query')
    for(const plan of plans)assert.ok(plan.some(row=>/COVERING INDEX sessions_capture_revision/.test(row.detail)),JSON.stringify(plan))
  } finally {
    DatabaseSync.prototype.prepare=prepare
    db.close()
  }
  assert.equal((await a.read(value.ref.path)).entries[0].text,value.entries[0].text)
})

test('existing archives gain the index without changing contents, tokens or format',async(a,_b,location)=>{
  await capture(a,thread('existing','Retained history'))
  await a.stop()
  const database=new DatabaseSync(join(location,'archive.sqlite'))
  let before
  try {
    database.exec('DROP INDEX sessions_capture_revision')
    before={row:database.prepare('SELECT * FROM sessions').get(),capture:database.prepare('SELECT * FROM archive_captures').get(),version:database.prepare('PRAGMA user_version').get()}
  } finally {database.close()}
  const reopened=new SessionArchive(location)
  try {
    await reopened.load()
    const reader=new DatabaseSync(join(location,'archive.sqlite'),{readOnly:true})
    try {
      assert.deepEqual(reader.prepare('SELECT * FROM sessions').get(),before.row)
      assert.deepEqual(reader.prepare('SELECT * FROM archive_captures').get(),before.capture)
      assert.deepEqual(reader.prepare('PRAGMA user_version').get(),before.version)
      assert.ok(reader.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='sessions_capture_revision'").get())
    } finally {reader.close()}
    let reads=0
    reopened.note(thread('existing').ref,async()=>{reads++;return thread('existing')})
    await reopened.flush()
    assert.equal(reads,0)
    assert.equal((await reopened.read('/fixture/native')).entries[0].text,'Retained history')
  } finally {await reopened.stop()}
})

test('settings-only and equal-length content corrections are retained', async (a) => {
  await capture(a,thread('one','old',{settings:{model:'model',options:{effort:'low'}}}))
  await capture(a,thread('one','old',{settings:{model:'model',options:{effort:'high'}}}))
  assert.equal((await a.read('/fixture/native')).ref.settings.options.effort,'high')
  await capture(a,thread('correction','new',{settings:{model:'model',options:{effort:'high'}}}))
  assert.equal((await a.read('/fixture/native')).entries[0].text,'new')
})

test('a delayed reader cannot overwrite a newer peer commit', async(a,b)=>{
  await capture(a,thread())
  let current=thread('two')
  const entered=deferred(), release=deferred()
  let reads=0
  a.note(current.ref,async()=>{reads++; const result=current;if(reads===1){entered.resolve();await release.promise}return result})
  const held=a.flush()
  await entered.promise
  current=thread('three')
  await capture(b,current)
  release.resolve()
  await held
  assert.equal((await a.read('/fixture/native')).entries[0].text,'three')
  assert.equal(reads,2,'a conflict must reread native state, not replay the stale snapshot')
})

test('a newer delayed read catches up after an older peer commit', async(a,b)=>{
  await capture(a,thread())
  const current=thread('three')
  const entered=deferred(),release=deferred()
  let reads=0
  a.note(current.ref,async()=>{reads++;if(reads===1){entered.resolve();await release.promise}return current})
  const held=a.flush();await entered.promise
  await capture(b,thread('two'))
  release.resolve();await held
  assert.equal((await b.read('/fixture/native')).entries[0].text,'three')
})

test('queued duplicate work is skipped after another host captures it',async(a,b,location)=>{
  await Promise.all([a.load(),b.load()])
  const value=thread()
  let reads=0
  a.note(value.ref,async()=>{reads++;return value})
  await capture(b,value)
  const observer=new DatabaseSync(join(location,'archive.sqlite'))
  const before=observer.prepare('PRAGMA data_version').get().data_version
  await a.flush()
  assert.equal(reads,0,'committed peer revision prevents redundant translation/attachment work')
  assert.equal(observer.prepare('PRAGMA data_version').get().data_version,before,'duplicate work does not mutate SQLite')
  observer.close()
})

test('a newer local observation invalidates an in-flight older capture',async(a)=>{
  const entered=deferred(),release=deferred()
  a.note(ref('one'),async()=>{entered.resolve();await release.promise;return thread('one')})
  const first=a.flush();await entered.promise
  a.note(ref('two'),async()=>thread('two'))
  release.resolve();await first
  assert.equal(await a.read('/fixture/native'),null,'superseded snapshot never commits')
  await a.flush()
  assert.equal((await a.read('/fixture/native')).entries[0].text,'two')
})

test('forget fences another host in-flight and survives restart',async(a,b,location)=>{
  await capture(a,thread())
  const entered=deferred(),release=deferred()
  b.note(ref('two'),async()=>{entered.resolve();await release.promise;return thread('two')})
  const held=b.flush();await entered.promise
  await a.forget('/fixture/native')
  release.resolve();await held
  assert.equal(await b.read('/fixture/native'),null)
  assert.equal(b.has('/fixture/native'),false)
  assert.deepEqual(b.orphans(new Set()),[])
  const fresh=new SessionArchive(location)
  try{await capture(fresh,thread('three'));assert.equal(await fresh.read('/fixture/native'),null)}finally{await fresh.stop()}
})

test('other hosts observe new archive rows without restarting',async(a,b)=>{
  await b.load()
  await capture(a,thread())
  assert.equal(b.has('/fixture/native'),true)
  assert.equal(b.orphans(new Set())[0].revision,'one')
  await capture(a,thread('two'))
  assert.equal(b.orphans(new Set())[0].revision,'two')
})

test('a peer commit during attachment copying invalidates the prepared snapshot',async(a,b,location)=>{
  await capture(a,thread())
  const source=join(location,'image.txt')
  await writeFile(source,'retained bytes')
  let current=thread('two')
  current.entries[0].attachments=[{type:'attachment',name:'image.txt',mimeType:'text/plain',source:{kind:'file',path:source}}]
  const entered=deferred(),release=deferred()
  const copy=fs.copyFile
  let held=false,reads=0,running
  fs.copyFile=async(from,to,...args)=>{
    if(from===source && !held){held=true;entered.resolve();await release.promise}
    return copy(from,to,...args)
  }
  syncBuiltinESMExports()
  try {
    a.note(current.ref,async()=>{reads++;return current})
    running=a.flush()
    await entered.promise
    current=thread('three')
    await capture(b,current)
    release.resolve();await running
    assert.equal(reads,2)
    assert.equal((await a.read('/fixture/native')).entries[0].text,'three')
  }finally{release.resolve();await running?.catch(()=>{});fs.copyFile=copy;syncBuiltinESMExports()}
})

test('old connections retain reads but cannot insert, update or delete after migration',async(a,_b,location)=>{
  await mkdir(location,{recursive:true})
  const old = new DatabaseSync(join(location,'archive.sqlite'))
  old.exec('CREATE TABLE sessions (path TEXT PRIMARY KEY, ref TEXT NOT NULL, entries TEXT NOT NULL, revision TEXT NOT NULL)')
  const value = thread()
  old.prepare('INSERT INTO sessions VALUES (?,?,?,?)').run(value.ref.path,JSON.stringify(value.ref),JSON.stringify(value.entries),'legacy')
  const prepared = old.prepare('UPDATE sessions SET entries=? WHERE path=?')
  try {
    await a.load()
    assert.equal((await a.read(value.ref.path)).entries[0].text,'one')
    assert.equal(JSON.parse(old.prepare('SELECT entries FROM sessions').get().entries)[0].text,'one')
    assert.throws(()=>prepared.run('[]',value.ref.path),/mako_archive_writer/)
    assert.throws(()=>old.prepare('INSERT INTO sessions VALUES (?,?,?,?)').run('/other','{}','[]','old'),/mako_archive_writer/)
    assert.throws(()=>old.prepare('DELETE FROM sessions').run(),/mako_archive_writer/)
    await capture(a,thread('two'))
    assert.equal(JSON.parse(old.prepare('SELECT entries FROM sessions').get().entries)[0].text,'two')
  } finally {old.close()}
})

test('noisy discovery returning identical content makes no database write',async(a,_b,location)=>{
  const value=thread()
  await capture(a,value)
  const observer=new DatabaseSync(join(location,'archive.sqlite'))
  const before=observer.prepare('PRAGMA data_version').get().data_version
  let reads=0
  a.note(ref('noisy-discovery'),async()=>{reads++;return value})
  await a.flush()
  assert.equal(reads,1)
  assert.equal(observer.prepare('PRAGMA data_version').get().data_version,before)
  observer.close()
})

test('wrong native paths and invalid entries cannot poison committed history',async(a)=>{
  await capture(a,thread())
  a.note(ref('two'),async()=>thread('two','two',{path:'/different'}))
  await assert.rejects(a.flush(),/different native path/)
  a.note(ref('three'),async()=>({...thread('three'),entries:[{kind:'user',text:123}]}))
  await assert.rejects(a.flush(),/text/)
  assert.equal((await a.read('/fixture/native')).entries[0].text,'one')
  await capture(a,thread('four'))
  assert.equal((await a.read('/fixture/native')).entries[0].text,'four')
})

test('repeated conflicts are bounded and a later observation can retry',async(a,b)=>{
  await capture(a,thread())
  let reads=0
  a.note(ref('attempt'),async()=>{
    reads++
    await capture(b,thread('peer-'+reads))
    return thread('attempt')
  })
  await assert.rejects(a.flush(),/three capture attempts/)
  assert.equal(reads,3)
  assert.equal((await a.read('/fixture/native')).entries[0].text,'peer-3')
  await capture(a,thread('later'))
  assert.equal((await a.read('/fixture/native')).entries[0].text,'later')
})

test('settings key order and repeated deletion make no extra commit',async(a,_b,location)=>{
  await capture(a,thread('one','one',{settings:{model:'model',options:{effort:'high',fast:false}}}))
  const observer=new DatabaseSync(join(location,'archive.sqlite'))
  try {
    let before=observer.prepare('PRAGMA data_version').get().data_version
    a.note(ref('one',{settings:{options:{fast:false,effort:'high'},model:'model'}}),async()=>{throw Error('Equivalent settings should skip native reading')})
    await a.flush()
    assert.equal(observer.prepare('PRAGMA data_version').get().data_version,before)
    await a.forget('/fixture/native')
    before=observer.prepare('PRAGMA data_version').get().data_version
    await a.forget('/fixture/native')
    assert.equal(observer.prepare('PRAGMA data_version').get().data_version,before)
  }finally{observer.close()}
})

async function worker(location) {
  const child=fork(new URL('./fixtures/archive-writer.mjs',import.meta.url),[location],{stdio:['ignore','pipe','pipe','ipc']})
  const messages=[], waiters=[]
  let stderr=''
  child.stderr.on('data',chunk=>{stderr+=chunk})
  child.on('message',message=>{
    const waiter=waiters.shift()
    if(waiter)waiter(message);else messages.push(message)
  })
  const next=async type=>{
    const message=messages.shift()??await new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>reject(new Error('Worker timeout '+type+' '+stderr)),10000)
      waiters.push(message=>{clearTimeout(timeout);resolve(message)})
    })
    assert.equal(message.type,type,JSON.stringify(message)+' '+stderr)
    return message
  }
  try { await next('ready') } catch(error) {
    if(child.exitCode===null && child.signalCode===null){const exited=once(child,'exit');child.kill('SIGTERM');await exited}
    throw error
  }
  return {child,next,send:message=>child.send(message),stop:async()=>{
    const exited=once(child,'exit');child.send({type:'stop'});await exited
  }}
}

test('independent processes reconcile stale reads and deletion, with no lock left by a crash',async(a,_b,location)=>{
  await a.load()
  const source=join(location,'native.json')
  await writeFile(source,JSON.stringify(thread('one')))
  const first=await worker(location), second=await worker(location)
  try {
    first.send({type:'capture',ref:ref('one'),source,hold:true})
    await first.next('reading')
    await writeFile(source,JSON.stringify(thread('two')))
    second.send({type:'capture',ref:ref('two'),source})
    await second.next('done')
    first.send({type:'release'})
    assert.equal((await first.next('done')).reads,2)
    assert.equal((await a.read('/fixture/native')).entries[0].text,'two')
    await writeFile(source,JSON.stringify(thread('three')))
    first.send({type:'capture',ref:ref('three'),source,hold:true})
    await first.next('reading')
    second.send({type:'forget',path:'/fixture/native'})
    await second.next('done')
    first.send({type:'release'})
    await first.next('done')
    assert.equal(await a.read('/fixture/native'),null)
    const other=thread('other','other',{path:'/fixture/other'})
    await writeFile(source,JSON.stringify(other))
    first.send({type:'capture',ref:other.ref,source,hold:true})
    await first.next('reading')
    const exited=once(first.child,'exit');first.child.kill('SIGKILL');await exited
    second.send({type:'capture',ref:other.ref,source})
    await second.next('done')
    assert.equal((await a.read('/fixture/other')).entries[0].text,'other')
  } finally {
    if(first.child.exitCode===null && first.child.signalCode===null)await first.stop()
    await second.stop()
  }
})

test('independent processes can initialize the same new archive',async(_a,_b,location)=>{
  for(let round=0;round<Number(process.env.MAKO_ARCHIVE_TEST_ROUNDS??1);round++) {
    const cold=join(location,'round-'+round)
    const results=await Promise.allSettled(Array.from({length:4},()=>worker(cold)))
    await Promise.all(results.filter(r=>r.status==='fulfilled').map(r=>r.value.stop()))
    for (const result of results) if(result.status==='rejected')throw result.reason
  }
  const reopened=new SessionArchive(location)
  try{await capture(reopened,thread());assert.equal((await reopened.read('/fixture/native')).entries[0].text,'one')}finally{await reopened.stop()}
})

test('initialization failure can be retried without restarting the archive owner',async(a,_b,location)=>{
  await writeFile(location,'not a directory')
  await assert.rejects(a.load())
  await rm(location)
  await capture(a,thread())
  assert.equal((await a.read('/fixture/native')).entries[0].text,'one')
})

let failures=0
try {
  for (const {name,run} of cases) {
    const location=join(root,String(cases.findIndex(c=>c.name===name)))
    const a=new SessionArchive(location),b=new SessionArchive(location)
    try{await run(a,b,location);console.log('PASS '+name)}catch(error){failures++;console.error('FAIL '+name+'\n'+error.stack)}finally{await a.stop().catch(()=>{});await b.stop().catch(()=>{})}
  }
}finally{await rm(root,{recursive:true,force:true})}
if(failures)process.exitCode=1
