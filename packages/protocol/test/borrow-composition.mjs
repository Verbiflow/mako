import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { emptyBroker, GrantSchema, NeedSchema, needKey, step } from '../dist/borrow.js'
const borrower={account:'acct',repository:'acme/web',thread:'t1',place:{kind:'machine',machine:'m1\0extra'}}
const need=(overrides={})=>NeedSchema.parse({kind:'operation',ref:'ios-simulator.session',for:borrower,why:'composition test',correlationId:'last',...overrides})
const grant=()=>GrantSchema.parse({id:'sims',resource:{kind:'operation',ref:'ios-simulator.*'},source:{kind:'capable',requires:[{capability:'ios-simulator'}]},scope:{level:'project',account:'acct',repository:'acme/web'},mode:'relay',access:'run',lifetime:{until:'revoked'},ask:'never',secret:false,grantedBy:{kind:'person',account:'acct'},grantedAt:1,version:1})
const legacy=(forWhom,correlation)=>`${forWhom.account}\0${forWhom.repository}\0${forWhom.thread}\0${forWhom.place.kind}:${forWhom.place.machine??forWhom.place.device}\0${correlation}`
function start(online=true){let state=step(emptyBroker('acct'),{type:'grant',grant:grant(),at:1}).state;if(online)state=step(state,{type:'advertise',device:'mac',capabilities:[{capability:'ios-simulator'}],slots:{used:0,of:4},at:2}).state;return state}
const borrow=(state,which=need(),lease='reserved',ask='ask',at=3)=>step(state,{type:'borrow',need:which,lease,ask,at})
describe('canonical migration composed with authenticated session behavior',()=>{
 test('legacy rich session answers recover once without cross-borrower reuse, and release keeps device tell/artifact cleanup',()=>{
  const pending=borrow(start());const yes=step(pending.state,{type:'source-answer',ask:'ask',answer:{answer:'yes',version:'ready'},at:4});assert.equal(yes.answer.lease.id,'reserved')
  let state=step(yes.state,{type:'heartbeat',lease:'reserved',device:'mac',streams:[{name:'screen',kind:'video'}],at:5}).state
  state=step(state,{type:'progress',lease:'reserved',device:'mac',progress:{phase:'running',percent:40},at:6}).state
  const artifact={name:'shot.png',hash:'a'.repeat(64),size:10}
  state=step(state,{type:'artifact',lease:'reserved',device:'mac',artifact,at:7}).state
  const held=state.leases.reserved.lease;state={...state,answers:{[legacy(borrower,'last')]:{lease:held}}}
  const retry=borrow(JSON.parse(JSON.stringify(state)),need(),'duplicate','duplicate-ask',8)
  assert.equal(retry.answer.lease.id,'reserved');assert.deepEqual(retry.answer.lease.session,held.session);assert.equal(retry.effects.some(e=>e.effect==='ask'),false)
  for(const input of [{type:'heartbeat',streams:[{name:'rogue',kind:'text'}]},{type:'progress',progress:{phase:'stopping'}},{type:'artifact',artifact:{...artifact,name:'rogue.png'}}])assert.ok(step(retry.state,{...input,lease:'reserved',device:'other',at:9}).rejected)
  const other=need({for:{...borrower,place:{kind:'machine',machine:'m1'}},correlationId:'extra\0last'})
  assert.equal(legacy(other.for,other.correlationId),legacy(borrower,'last'))
  const separate=borrow(retry.state,other,'second','second-ask',10);assert.equal(separate.answer.pending,'source');assert.equal(separate.answer.ask,'second-ask');assert.equal(separate.state.leases.second,undefined)
  const released=step(separate.state,{type:'release',lease:'reserved',at:11})
  assert.deepEqual(released.effects.filter(e=>e.effect==='tell'),[{effect:'tell',device:'mac',push:{push:'ended',lease:'reserved',why:'released'}}])
  assert.equal(released.state.leases.reserved.lease.session.artifacts,undefined);assert.ok(released.effects.some(e=>e.effect==='unreferenced'&&e.version===artifact.hash))
 })
 test('persisted legacy capable source-pending asks retain reserved IDs and fence late duplicate source answers',()=>{
  const pending=borrow(start());const canonical=needKey(borrower,'last');const old=legacy(borrower,'last')
  const state=JSON.parse(JSON.stringify({...pending.state,answers:{[old]:pending.answer},asks:{...pending.state.asks,late:{...pending.state.asks.ask,ask:'late',leaseId:'late-lease',at:4}}}))
  const retry=borrow(state,need(),'replacement','replacement-ask',5)
  assert.equal(retry.answer.ask,'ask');assert.equal(retry.effects.some(e=>e.effect==='ask'),false);assert.deepEqual(Object.keys(retry.state.asks),['ask']);assert.equal(retry.state.asks.ask.leaseId,'reserved')
  const late=step(retry.state,{type:'source-answer',ask:'late',answer:{answer:'yes',version:'ready'},at:6});assert.equal(late.state.leases['late-lease'],undefined)
  const accepted=step(late.state,{type:'source-answer',ask:'ask',answer:{answer:'yes',version:'ready'},at:7});assert.equal(accepted.answer.lease.id,'reserved');assert.equal(accepted.answer.lease.device,'mac');assert.equal(accepted.state.answers[canonical].lease.id,'reserved')
  assert.ok(step(accepted.state,{type:'progress',lease:'reserved',device:'other',progress:{phase:'running'},at:8}).rejected)
  const revoked=step(accepted.state,{type:'revoke',grant:'sims',by:{kind:'person',account:'acct'},at:9});assert.ok(revoked.effects.some(e=>e.effect==='tell'&&e.push.why==='revoked'))
 })
 test('canonical capable wait wins a legacy source ask while preserving age, deadline and reserved IDs',()=>{
  const waiting=borrow(start(false),need(),'queued-lease','queued-ask',3);assert.equal(waiting.answer.pending,'capacity')
  const key=needKey(borrower,'last'),record=waiting.state.waiting[key]
  const old=borrow(start(),need(),'legacy-lease','legacy-ask',3)
  const mixed={...waiting.state,asks:old.state.asks,answers:{[legacy(borrower,'last')]:old.answer}}
  const retry=borrow(JSON.parse(JSON.stringify(mixed)),need(),'replacement','replacement-ask',4)
  assert.equal(retry.answer.pending,'capacity');assert.deepEqual(retry.state.waiting[key],record);assert.deepEqual(retry.state.asks,{})
  const room=step(retry.state,{type:'advertise',device:'mac',capabilities:[{capability:'ios-simulator'}],slots:{used:0,of:4},at:5})
  assert.equal(room.state.asks['queued-ask'].leaseId,'queued-lease')
  const late=step(room.state,{type:'source-answer',ask:'legacy-ask',answer:{answer:'yes',version:'ready'},at:6});assert.equal(late.state.leases['legacy-lease'],undefined)
  const yes=step(late.state,{type:'source-answer',ask:'queued-ask',answer:{answer:'yes',version:'ready'},at:7});assert.equal(yes.answer.lease.id,'queued-lease');assert.equal(yes.answer.lease.device,'mac')
 })
})
