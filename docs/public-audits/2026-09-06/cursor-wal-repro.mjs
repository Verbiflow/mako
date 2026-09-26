// Diagnostic: asserts known defects. Uses synthetic fixtures and mocked transport only.
import assert from 'node:assert/strict'
import {mkdtemp,rm,stat} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {CursorProvider} from '../../../packages/sessions/src/providers/cursor.ts'
import {SessionCatalog} from '../../../packages/sessions/src/catalog.ts'
import {emitCursorSession} from '../../../packages/sessions/src/emit.ts'
const home=await mkdtemp(join(tmpdir(),'mako-cursor-wal-'))
let db
try {
 const emitted=await emitCursorSession({ref:{harness:'cursor',nativeId:'source',path:'/source',cwd:'/work',title:'before'},entries:[{kind:'user',text:'hello'}]},{cwd:'/work',home})
 db=new DatabaseSync(emitted.path)
 db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_checkpoint(TRUNCATE)')
 const provider=new CursorProvider(home), catalog=new SessionCatalog([provider]);await catalog.scan()
 const before=await stat(emitted.path)
 const row=db.prepare("SELECT value FROM meta WHERE key='0'").get();const meta=JSON.parse(Buffer.from(String(row.value),'hex').toString());meta.name='after'
 db.prepare("UPDATE meta SET value=? WHERE key='0'").run(Buffer.from(JSON.stringify(meta)).toString('hex'))
 const after=await stat(emitted.path)
 assert.equal(after.size,before.size);assert.equal(after.mtimeMs,before.mtimeMs)
 await catalog.rescanProvider(provider)
 const fresh=await provider.peek({path:emitted.path,bytes:after.size,mtimeMs:after.mtimeMs})
 assert.equal(fresh?.title,'after'); assert.equal(catalog.list()[0].title,'before')
 console.log('CONFIRMED Cursor WAL-only rename: native peek title after, watcher rescan catalog title before; main store stat unchanged')
 catalog.stop()
}finally{db?.close();await rm(home,{recursive:true,force:true})}
