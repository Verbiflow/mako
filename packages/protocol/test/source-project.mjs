import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {SourceProjectSelectionSchema,sourceProjectCommand,readSourceProjectBody} from '../dist/source-project.js';
const selection=()=>({move:randomUUID(),destination:'t-selected',sourceThread:randomUUID(),project:'/Users/example/project',locators:[{slot:'primary',kind:'primary',url:'https://github.com/owner/primary',path:'/Users/example/project/primary',checkpoint:'a'.repeat(64)},{slot:'other',kind:'secondary',url:'https://github.com/owner/secondary',path:'/Users/example/project/secondary',checkpoint:'b'.repeat(64)}],sessions:[{session:randomUUID(),generation:1}]});
test('selected project remains move-bound and finite',()=>{const selected=selection();assert.deepEqual(SourceProjectSelectionSchema.parse(selected),selected);assert.throws(()=>SourceProjectSelectionSchema.parse({...selected,locators:[selected.locators[0],{...selected.locators[1],path:selected.locators[0].path+'/nested'}]}));assert.throws(()=>sourceProjectCommand({action:'publish',revision:1,expiresAt:Date.now()+5000,selection:selected,account:randomUUID()}));});
test('HTTP body aggregate cap refuses before interpretation',async()=>{await assert.rejects(readSourceProjectBody(new Request('https://local/',{method:'POST',body:'x'.repeat(32769)})));assert.equal(new TextDecoder().decode(await readSourceProjectBody(new Request('https://local/',{method:'POST',body:'{}'}))),'{}');});

test('command schema preprocessing preserves proxy failure identity before interpretation',()=>{
 const failure={kind:'SYNTHETIC_PROXY_FAILURE'}, value=new Proxy({}, {ownKeys(){throw failure;}});
 assert.throws(()=>sourceProjectCommand(value),error=>error===failure);
});
