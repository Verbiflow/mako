import { prepare, layout, clearCache } from '/tmp/mako-ui-pilot-pretext/src/layout.ts';
const cases = [
 ['english','The transcript preserves your place while an agent writes its answer. A sidebar resize should keep the same paragraph on screen. '.repeat(12)],
 ['cjk','日本語の文章を折り返します。中文测试，保留标点与换行。한국어 문장과 공백 처리. '.repeat(14)],
 ['rtl','بدأت الرحلة ونكتب نصا طويلا لاختبار التفاف السطور. שלום עולם mixed English 123 العربية. '.repeat(12)],
 ['thai','ภาษาไทยไม่มีช่องว่างระหว่างคำ ทดสอบการตัดบรรทัดและความกว้างของข้อความ '.repeat(14)],
 ['emoji','👨‍👩‍👧‍👦 🚀, hello! 👩🏽‍💻 ✅ (🎉) e\u0301 café. '.repeat(30)],
 ['long-word','https://example.invalid/'+ 'AVffiIdentifier0123456789'.repeat(200)],
 ['code','function measure(value) {\n\tconst path = "src/components/transcript/conversation-timeline.tsx";\n\treturn value.map(item => item.height);\n}\n'.repeat(18)],
 ['whitespace','  leading  spaces\tand tabs\n\nnext line\n'.repeat(20)],
 ['controls','foo\u200bbar \u2060baz co\u00adoperate\u00a0now '.repeat(40)],
 ['empty',''], ['trailing-newline','one\ntwo\n']
];
const configs = [
 {name:'Geist prose 14',font:'440 14px "Geist Variable"',lineHeight:22.4,spacing:-0.04,whiteSpace:'normal'},
 {name:'platform mono 12',font:'440 12px ui-monospace, "SF Mono", SFMono-Regular, Menlo, Monaco, Consolas, monospace',lineHeight:19.2,spacing:-0.04,whiteSpace:'pre-wrap'}
];
const widths = [360,640,900];
const fixture = document.querySelector('#fixtures');
function nodeFor(text,c,width){const n=document.createElement('div'); Object.assign(n.style,{font:c.font,lineHeight:c.lineHeight+'px',letterSpacing:c.spacing+'px',whiteSpace:c.whiteSpace,overflowWrap:c.overflowWrap??'anywhere',fontFeatureSettings:c.features??'"ss01", "ss03"',width:width+'px',padding:'0',border:'0',margin:'0'}); n.textContent=text;fixture.append(n);return n;}
function prep(text,c){return prepare(text,c.font,{whiteSpace:c.whiteSpace,letterSpacing:c.spacing});}
function median(xs){return xs.toSorted((a,b)=>a-b)[Math.floor(xs.length/2)];}
function timed(fn){let t=performance.now();fn();return performance.now()-t;}
function measure(fn,n=7){return Array.from({length:n},()=>timed(fn));}
async function run(){
 const button=document.querySelector('button');button.disabled=true;document.querySelector('#status').textContent='Running…';
 await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
 await document.fonts.load('440 14px "Geist Variable"');await document.fonts.ready;
 clearCache();
 const startEnvironment={userAgent:navigator.userAgent,dpr:devicePixelRatio,width:innerWidth,height:innerHeight,scale:visualViewport?.scale,visibility:document.visibilityState,focused:document.hasFocus(),fontReady:document.fonts.check('440 14px "Geist Variable"')};
 const accuracy=[];
 for(const c of configs){const strut=nodeFor('x\nx',{...c,whiteSpace:'pre-wrap'},640);const usedLineHeight=strut.getBoundingClientRect().height/2;strut.remove();
 for(const [id,text] of cases){const p=prep(text,c); for(const width of widths){const n=nodeFor(text,c,width);const actual=n.getBoundingClientRect().height;const predicted=layout(p,width,c.lineHeight); const actualLines=Math.round(actual/usedLineHeight);accuracy.push({config:c.name,id,width,chars:text.length,actualHeight:actual,pretextHeight:predicted.height,delta:predicted.height-actual,actualLines,pretextLines:predicted.lineCount,lineMatch:actualLines===predicted.lineCount,usedLineHeight});n.remove();}}}
 const textareaAccuracy=[];
 const textareaConfigs=[{...configs[0],name:'requested Geist 14 textarea',whiteSpace:'pre-wrap'},{...configs[0],name:'current Mako Geist 13 textarea',font:'440 13px "Geist Variable"',lineHeight:20.15,whiteSpace:'pre-wrap'}];
 const textareaCases=[['empty',''],['newline','\n'],['trailing','one\ntwo\n'],['tabs','a\tb\tend\n\tindented'],['spaces','     a     b           c  '],['long','AVffi'.repeat(100)],['multilingual','日本語 العربية 👩🏽‍💻 ภาษาไทย '.repeat(10)],['whitespace-only','   \t  \n']];
 for(const c of textareaConfigs)for(const [id,text] of textareaCases)for(const width of [80,120,...widths]){
 const n=document.createElement('textarea');n.rows=1;Object.assign(n.style,{font:c.font,lineHeight:c.lineHeight+'px',letterSpacing:c.spacing+'px',fontFeatureSettings:'"ss01", "ss03"',whiteSpace:'pre-wrap',overflowWrap:'break-word',boxSizing:'border-box',width:width+'px',padding:'8px 12px 4px',border:'0',margin:'0',minHeight:'40px',resize:'none',overflow:'hidden'});n.value=text;fixture.append(n);n.style.height='0px';const scrollHeight=n.scrollHeight;n.style.height=scrollHeight+'px';const actualHeight=n.getBoundingClientRect().height;
 n.style.fieldSizing='content';n.style.height='auto';const nativeFieldSizingHeight=n.getBoundingClientRect().height;
 const raw=layout(prep(text,c),width-24,c.lineHeight).height;
 const editableText=(text===''||text.endsWith('\n'))?text+'\u200b':text;
 const sentinelHeight=Math.max(40,layout(prep(editableText,c),width-24,c.lineHeight).height+12);
 const rawLines=layout(prep(text,c),width-24,c.lineHeight).lineCount;
 const adapted=Math.max(40,Math.max(1,rawLines+(text.endsWith('\n')?1:0))*c.lineHeight+12);
 textareaAccuracy.push({config:c.name,id,width,contentWidth:width-24,scrollHeight,actualHeight,nativeFieldSizingHeight,nativeDelta:nativeFieldSizingHeight-actualHeight,rawTextHeight:raw,sentinelHeight,adaptedHeight:adapted,delta:adapted-actualHeight,withinOnePixel:Math.abs(adapted-actualHeight)<=1});n.remove();}
 const mismatchProbes=[];
 for(const features of ['normal','"ss01", "ss03"'])for(const overflowWrap of ['anywhere','break-word']){const c={...configs[0],features,overflowWrap};const text=cases.find(x=>x[0]==='long-word')[1];const n=nodeFor(text,c,360);const actual=n.getBoundingClientRect().height;const predicted=layout(prep(text,c),360,c.lineHeight);mismatchProbes.push({features,overflowWrap,actualHeight:actual,pretextHeight:predicted.height});n.remove();}
 const c=configs[0];const texts=Array.from({length:500},(_,i)=>`${i}: ${cases[0][1].slice(0,120+(i%5)*70)}`);
 const coldSamples=measure(()=>{clearCache();texts.map(t=>prep(t,c));});
 const prepared=texts.map(t=>prep(t,c));let checksum=0;
 const hotSamples=measure(()=>{for(let r=0;r<100;r++)for(const p of prepared)checksum+=layout(p,widths[r%3],c.lineHeight).height;}).map(t=>t/100);
 const nodes=texts.map(t=>nodeFor(t,c,400));fixture.getBoundingClientRect();let iteration=0;
 const batchedSamples=measure(()=>{const w=widths[iteration++%3];for(const n of nodes)n.style.width=w+'px';for(const n of nodes)checksum+=n.getBoundingClientRect().height;});
 const interleavedSamples=measure(()=>{const w=widths[iteration++%3];for(const n of nodes){n.style.width=w+'px';checksum+=n.getBoundingClientRect().height;}});
 fixture.replaceChildren();
 const streamText=(cases[0][1]+'\n\n').repeat(16);const prefixes=Array.from({length:120},(_,i)=>streamText.slice(0,Math.ceil(streamText.length*(i+1)/120)));
 clearCache();const streamNode=nodeFor('',{...c,whiteSpace:'pre-wrap'},640);const sc={...c,whiteSpace:'pre-wrap'}; const streamPrepared=[];const streamDOM=[];let streamMismatches=0;
 for(const text of prefixes){let h;streamPrepared.push(timed(()=>{h=layout(prep(text,sc),640,sc.lineHeight);}));let actual;streamDOM.push(timed(()=>{streamNode.textContent=text;actual=streamNode.getBoundingClientRect().height;}));if(Math.abs(h.height-actual)>sc.lineHeight/2)streamMismatches++;}
 streamNode.remove();
 // An explicit paragraph stream is safe to partition. This is NOT a Markdown parser.
 const blockCache=new Map();const blockSamples=prefixes.map(text=>timed(()=>{for(const paragraph of text.split('\n\n')){let p=blockCache.get(paragraph);if(!p){p=prep(paragraph,c);blockCache.set(paragraph,p);}checksum+=layout(p,640,c.lineHeight).height;}}));
 const result={pretextCommit:'8460bf940c50d82be90a396fb0ea2c4e7a2dc6f3',environment:startEnvironment,endEnvironment:{dpr:devicePixelRatio,width:innerWidth,height:innerHeight,scale:visualViewport?.scale},method:'Synthetic DOM div text fixtures using Mako font size/weight/spacing and ss01/ss03. Mono deliberately wraps to stress layout; real Mako fenced code uses horizontal scrolling. Timing samples are diagnostic, not upstream foreground-controlled benchmarks. Warm layout excludes preparation, DOM creation, paint and Markdown parsing. Cold samples clear shared caches but font/JIT/browser caches remain warm. No Mako runtime or private thread data.',accuracySummary:{total:accuracy.length,lineMismatches:accuracy.filter(x=>!x.lineMatch).length,maxAbsHeightDelta:Math.max(...accuracy.map(x=>Math.abs(x.delta)))},accuracy,nativeFieldSizingSupported:CSS.supports('field-sizing','content'),textareaSummary:{nativeMismatches:textareaAccuracy.filter(x=>Math.abs(x.nativeDelta)>1).length,total:textareaAccuracy.length,mismatches:textareaAccuracy.filter(x=>!x.withinOnePixel).length},textareaAccuracy,mismatchProbes,timings:{batchSize:500,coldPrepareMs:{median:median(coldSamples),samples:coldSamples},warmLayoutMs:{median:median(hotSamples),samples:hotSamples},domBatchWriteReadMs:{median:median(batchedSamples),samples:batchedSamples},domInterleavedWriteReadMs:{median:median(interleavedSamples),samples:interleavedSamples}},streaming:{steps:prefixes.length,finalCharacters:streamText.length,fullReprepareMs:{total:streamPrepared.reduce((a,b)=>a+b,0),median:median(streamPrepared),max:Math.max(...streamPrepared)},domAppendReadMs:{total:streamDOM.reduce((a,b)=>a+b,0),median:median(streamDOM)},plainParagraphCacheMs:{total:blockSamples.reduce((a,b)=>a+b,0),median:median(blockSamples)},heightMismatches:streamMismatches,note:'Full-prefix assignment models immutable streaming updates. Paragraph cache demonstrates only explicit plain paragraphs; Markdown may invalidate earlier blocks. Shared segment caches are warm for the later cache scenario; totals are not a controlled head-to-head.'},checksum};
 document.querySelector('#result').textContent=JSON.stringify(result,null,2);document.querySelector('#status').textContent=`Done: ${accuracy.length} height checks; ${result.accuracySummary.lineMismatches} line mismatches; ${textareaAccuracy.filter(x=>!x.withinOnePixel).length}/${textareaAccuracy.length} textarea mismatches; ${textareaAccuracy.filter(x=>Math.abs(x.nativeDelta)>1).length} native field-sizing mismatches. Cold ${median(coldSamples).toFixed(2)} ms, warm ${median(hotSamples).toFixed(3)} ms, batched DOM ${median(batchedSamples).toFixed(2)} ms, interleaved DOM ${median(interleavedSamples).toFixed(2)} ms per 500 paragraphs.`;
 if(location.protocol!=='file:')await fetch('/results',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(result,null,2)});
 const blob=new Blob([JSON.stringify(result,null,2)],{type:'application/json'});const a=document.querySelector('#download');if(a.dataset.blob)URL.revokeObjectURL(a.dataset.blob);a.href=URL.createObjectURL(blob);a.dataset.blob=a.href;a.hidden=false;button.disabled=false;
}
document.querySelector('button').onclick=()=>run().catch(e=>{document.querySelector('#status').textContent=String(e.stack);document.querySelector('button').disabled=false;});
