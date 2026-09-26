// Diagnostic: asserts the known defects, not the desired behavior. Synthetic temp files only.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, appendFile, rm, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SessionArchive } from '../../../packages/sessions/src/archive.ts'
import { SessionCatalog } from '../../../packages/sessions/src/catalog.ts'
import { ClaudeProvider } from '../../../packages/sessions/src/providers/claude.ts'
const root = await mkdtemp(join(tmpdir(), 'mako-storage-repro-'))
const line = x => JSON.stringify(x)+'\n'
try {
 const archive = new SessionArchive(join(root,'archive'))
 const ref = {harness:'claude', nativeId:'example', path:join(root,'native'), bytes:100, updatedAt:'2026-01-01T00:00:00Z'}
 const entries = [{kind:'user', text:'run'}, {kind:'assistant', blocks:[{type:'tool',name:'shell',input:'pwd'}]}]
 await archive.write(ref, async () => ({ref,entries:structuredClone(entries)}))
 const updatedRef = {...ref,bytes:200, updatedAt:'2026-01-01T00:01:00Z'}
 entries[1].blocks[0].output='completed result'
 await archive.write(updatedRef,async()=>({ref:updatedRef,entries:structuredClone(entries)}))
 const saved = await archive.read(ref.path)
 assert.equal(saved?.entries[1].blocks[0].output, undefined)
 assert.equal(saved?.ref.bytes,200)
 console.log('CONFIRMED archive records new revision while tool output remains missing at unchanged entry count')
 const home=join(root,'home'); const path=join(home,'.claude','projects','p','s.jsonl'); await mkdir(join(home,'.claude','projects','p'),{recursive:true})
 const first=line({type:'user',sessionId:'s',cwd:'/work',message:{content:'first'}})
 const second=line({type:'user',sessionId:'s',cwd:'/work',message:{content:'second'}})
 await writeFile(path,first+second.slice(0,20))
 const provider = new ClaudeProvider(home); const before=await provider.read(path)
 const follower=provider.createFollower(path,before.ref.bytes)
 await appendFile(path,second.slice(20))
 const update=await follower.next(); const full=await provider.read(path)
 assert.equal(update.entries.length,0);assert.equal(full.entries.length,2)
 console.log('CONFIRMED partial-line open/follow loses completed user turn: full read has 2 entries, opened+follow has 1')
 const archiveRoot=join(root,'initial-archive'); const catalog=new SessionCatalog([provider],{archivePath:archiveRoot})
 await catalog.scan(); await catalog.open(path); await new Promise(r=>setTimeout(r,3500))
 assert.deepEqual(await readdir(archiveRoot).catch(()=>[]),[])
 console.log('CONFIRMED initial scan and open do not archive an existing session')
 catalog.stop()
 await writeFile(path, first+line({type:'user',sessionId:'s',cwd:'/work',message:{content:[{type:'image',source:{type:'base64',media_type:'image/png',data:'aGVsbG8='}}]}}))
 const imageThread=await provider.read(path);assert.equal(imageThread.entries.length,1)
 console.log('CONFIRMED Claude image-only user turn completely absent from canonical session')
} finally { await rm(root,{recursive:true,force:true}) }
