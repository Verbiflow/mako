import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { DatabaseSync } from 'node:sqlite'
import { SessionArchive } from '../dist/archive.js'
import { keepCopies } from './fixtures/archive-copies.mjs'

/**
 * The archive shared between hosts: a writer of this build only drops rows,
 * other hosts see each drop without restarting, older builds see a dropped
 * row deleted and can't bring it back, connections from before the writer
 * triggers can read but not write, and several processes open and drop
 * from the same archive at once.
 */

const root = await mkdtemp(join(tmpdir(), 'mako-archive-concurrency-'))
const ref = (revision = 'one', extra = {}) => ({ harness:'fixture',nativeId:'native',path:'/fixture/native',revision,bytes:100,...extra })
const thread = (revision='one', text=revision, extra={}) => ({ref:ref(revision,extra),entries:[{type:'user',text}]})
const cases = []
const test = (name, run) => cases.push({name,run})

test('an existing archive gains the migration ledger without changing contents, tokens or format',async(a,_b,location)=>{
  await keepCopies(location,[thread('existing','Retained history')])
  const database=new DatabaseSync(join(location,'archive.sqlite'))
  let before
  try {
    database.exec('DROP INDEX sessions_capture_revision')
    before={row:database.prepare('SELECT * FROM sessions').get(),capture:database.prepare('SELECT * FROM archive_captures').get(),version:database.prepare('PRAGMA user_version').get()}
  } finally {database.close()}
  await a.load()
  const reader=new DatabaseSync(join(location,'archive.sqlite'),{readOnly:true})
  try {
    assert.deepEqual(reader.prepare('SELECT * FROM sessions').get(),before.row)
    assert.deepEqual(reader.prepare('SELECT * FROM archive_captures').get(),before.capture)
    assert.deepEqual(reader.prepare('PRAGMA user_version').get(),before.version,'older builds still read it')
    assert.ok(reader.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='sessions_capture_revision'").get(),'the index older builds admit captures by')
    assert.ok(reader.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='archive_migration'").get())
  } finally {reader.close()}
  const kept=await a.read('/fixture/native')
  assert.equal(kept.entries[0].text,'Retained history')
  assert.deepEqual([kept.ref.archived,kept.ref.copyOnly],[true,true],'a copy is served as Mako\'s copy only')
})

test('a drop is seen by other hosts without restarting, and by older builds as deleted',async(a,b,location)=>{
  await keepCopies(location,[thread(),thread('other','other',{path:'/fixture/other',nativeId:'other'})])
  await b.load()
  assert.equal(b.has('/fixture/native'),true)
  await a.drop('/fixture/native','harness')
  assert.equal(b.has('/fixture/native'),false)
  assert.deepEqual(b.orphans(new Set()).map((kept)=>kept.path),['/fixture/other'])
  assert.equal(await b.read('/fixture/native'),null)
  const observer=new DatabaseSync(join(location,'archive.sqlite'),{readOnly:true})
  try {
    // What an older build asks before it captures: a deleted path is never captured again.
    assert.equal(observer.prepare('SELECT deleted FROM archive_captures WHERE path=?').get('/fixture/native').deleted,1)
    assert.deepEqual({...observer.prepare("SELECT state, via FROM archive_migration WHERE path=?").get('/fixture/native')},{state:'migrated',via:'harness'})
  } finally {observer.close()}
})

test('the person forgetting a copy takes it out of the ledger too, and a repeat writes nothing',async(a,_b,location)=>{
  await keepCopies(location,[thread()])
  await a.load()
  assert.equal(a.markCopy('/fixture/native'),true)
  assert.equal(a.markCopy('/fixture/native'),false,'noted once')
  assert.deepEqual(a.counts(),{rows:1,migrated:0,copies:1,pending:0})
  const observer=new DatabaseSync(join(location,'archive.sqlite'))
  try {
    await a.forget('/fixture/native')
    assert.deepEqual(a.counts(),{rows:0,migrated:0,copies:0,pending:0})
    const before=observer.prepare('PRAGMA data_version').get().data_version
    await a.forget('/fixture/native')
    assert.equal(observer.prepare('PRAGMA data_version').get().data_version,before,'a repeated forget commits nothing')
  } finally {observer.close()}
})

test('old connections retain reads but cannot insert, update or delete once a writer opened it',async(a,_b,location)=>{
  await mkdir(location,{recursive:true})
  const old = new DatabaseSync(join(location,'archive.sqlite'))
  old.exec('CREATE TABLE sessions (path TEXT PRIMARY KEY, ref TEXT NOT NULL, entries TEXT NOT NULL, revision TEXT NOT NULL)')
  const value = thread()
  old.prepare('INSERT INTO sessions VALUES (?,?,?,?)').run(value.ref.path,JSON.stringify(value.ref),JSON.stringify(value.entries),'legacy')
  const prepared = old.prepare('UPDATE sessions SET entries=? WHERE path=?')
  try {
    await a.load()
    assert.equal((await a.read(value.ref.path)).entries[0].text,'one')
    assert.throws(()=>prepared.run('[]',value.ref.path),/mako_archive_writer/)
    assert.throws(()=>old.prepare('INSERT INTO sessions VALUES (?,?,?,?)').run('/other','{}','[]','old'),/mako_archive_writer/)
    assert.throws(()=>old.prepare('DELETE FROM sessions').run(),/mako_archive_writer/)
    await a.drop(value.ref.path,'harness')
    assert.equal(old.prepare('SELECT count(*) AS n FROM sessions').get().n,0)
  } finally {old.close()}
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

test('independent processes open the same archive and drop rows side by side, with no lock left by a crash',async(a,_b,location)=>{
  const paths=Array.from({length:8},(_,index)=>`/fixture/s${index}`)
  await keepCopies(location,paths.map((path,index)=>thread(String(index),String(index),{path,nativeId:`s${index}`})))
  const workers=await Promise.all(Array.from({length:4},()=>worker(location)))
  try {
    await Promise.all(workers.map(async(each,index)=>{
      for(const path of paths.filter((_,at)=>at%4===index)){each.send({type:'drop',path});await each.next('done')}
    }))
    const crashed=workers.pop()
    const exited=once(crashed.child,'exit');crashed.child.kill('SIGKILL');await exited
    await a.load()
    assert.deepEqual(a.counts(),{rows:0,migrated:8,copies:0,pending:0})
  } finally {
    for(const each of workers)if(each.child.exitCode===null && each.child.signalCode===null)await each.stop()
  }
})

let failures=0
try {
  for (const {name,run} of cases) {
    const location=join(root,String(cases.findIndex(c=>c.name===name)))
    const a=new SessionArchive(location),b=new SessionArchive(location,{readOnly:true})
    try{await run(a,b,location);console.log('PASS '+name)}catch(error){failures++;console.error('FAIL '+name+'\n'+error.stack)}finally{await a.stop().catch(()=>{});await b.stop().catch(()=>{})}
  }
}finally{await rm(root,{recursive:true,force:true})}
if(failures)process.exitCode=1
