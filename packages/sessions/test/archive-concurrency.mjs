import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { SessionArchive } from '../dist/archive.js'

const root = await mkdtemp(join(tmpdir(), 'mako-archive-concurrency-'))
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const ref = (revision = 'one', extra = {}) => ({ harness:'fixture',nativeId:'native',path:'/fixture/native',revision,bytes:100,...extra })
const thread = (revision='one', text=revision, extra={}) => ({ref:ref(revision,extra),entries:[{kind:'user',text}]})
const cases = []
const test = (name, run) => cases.push({name,run})
const capture = async (archive, value) => { archive.note(value.ref,async()=>value);await archive.flush() }

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

let failures=0
try {
  for (const {name,run} of cases) {
    const location=join(root,String(cases.findIndex(c=>c.name===name)))
    const a=new SessionArchive(location),b=new SessionArchive(location)
    try{await run(a,b,location);console.log('PASS '+name)}catch(error){failures++;console.error('FAIL '+name+'\n'+error.stack)}finally{await a.stop().catch(()=>{});await b.stop().catch(()=>{})}
  }
}finally{await rm(root,{recursive:true,force:true})}
if(failures)process.exitCode=1
