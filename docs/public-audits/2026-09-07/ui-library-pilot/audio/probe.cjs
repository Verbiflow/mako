// Silent source-execution probes. Fake Web Audio only; no device access.
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const ts=require('./cuelume/node_modules/typescript');
function moduleAt(path, extras={},imports={}) {
 const code=ts.transpileModule(fs.readFileSync(__dirname+'/'+path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const exports={};vm.runInNewContext(code,{exports,require:n=>{if(n in imports)return imports[n];throw Error(n)},...extras});return exports;
}
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}};
(async()=>{
 let decodes=0;const pending=[];const nodes=[];
 class FakeContext {state='running';destination={};decodeAudioData(){decodes++;const d=deferred();pending.push(d);return d.promise}createBufferSource(){const s={playbackRate:{value:1},connect(){},start(){},stop(){this.stopped=true},stopped:false};nodes.push(s);return s}createGain(){return {gain:{value:1},connect(){}}}}
 const engine=moduleAt('soundcn/registry/soundcn/lib/sound-engine.ts',{AudioContext:FakeContext,atob});
 const a=engine.decodeAudioData('data:audio/mpeg;base64,AA=='),b=engine.decodeAudioData('data:audio/mpeg;base64,AA==');
 assert.equal(decodes,2);pending.forEach(d=>d.resolve({duration:1}));await Promise.all([a,b]);
 const effects=[];const react={useCallback:f=>f,useEffect:f=>effects.push(f),useRef:v=>({current:v}),useState:v=>[v,()=>{}]};
 const hook=moduleAt('soundcn/registry/soundcn/hooks/use-sound.ts',{}, {'react':react,'@/lib/sound-engine':engine});
 const [play]=hook.useSound({dataUri:'data:audio/mpeg;base64,AA==',duration:1});const cleanups=effects.map(f=>f());await Promise.resolve();await Promise.resolve();
 play();play();cleanups.forEach(f=>f?.());assert.equal(nodes.length,2);assert.equal(nodes[0].stopped,false);assert.equal(nodes[1].stopped,true);
 engine.getAudioContext().state='closed';assert.equal(engine.getAudioContext().state,'closed');
 const gate=deferred();const gains=[];const param=()=>({value:0,setValueAtTime(){},exponentialRampToValueAtTime(){}});
 let ctx;
 class CueContext {constructor(){ctx=this}state='suspended';currentTime=0;sampleRate=44100;destination={};resume(){return gate.promise}createGain(){const n={gain:param(),connect(){return this},disconnect(){}};gains.push(n);return n}createDynamicsCompressor(){return {threshold:param(),knee:param(),ratio:param(),attack:param(),release:param(),connect(){return this}}}createDelay(){return {delayTime:param(),connect(){return this},disconnect(){}}}createBiquadFilter(){return {frequency:param(),connect(){return this},disconnect(){}}}createOscillator(){return {frequency:param(),detune:param(),connect(){return this},start(){},stop(){}}}}
 const recipes=moduleAt('cuelume/src/sounds/recipes.ts');
 const cue=moduleAt('cuelume/src/audio/engine.ts',{window:{AudioContext:CueContext},navigator:{userActivation:{hasBeenActive:true}},setTimeout(){}},{'../sounds/recipes.js':recipes});
 cue.play('chime');cue.setVolume(0);ctx.state='running';gate.resolve();await Promise.resolve();assert.ok(gains[1].gain.value>0);
 const result={concurrent_same_asset_decodes:decodes,overlap_sources_left_after_unmount:nodes.filter(n=>!n.stopped).length,closed_context_reused:true,cuelume_pending_play_gain_after_setVolumeZero:gains[1].gain.value};
 fs.writeFileSync(__dirname+'/probe-results.json',JSON.stringify(result,null,2));console.log(result);
})().catch(e=>{console.error(e);process.exitCode=1});
