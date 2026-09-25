// Drives only the private Linux test browser through Mako's shared typed SDK.
// The marker oracle samples decoded canvas/video pixels, not physical scanout.
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { readFile, writeFile } from "node:fs/promises"
import { setTimeout as delay } from "node:timers/promises"
import { createControlRuntime } from "@mako/control-runtime"
import { controlClient } from "@mako/control/control"

const mode = process.argv[2]
const seconds = Number(process.env.MAKO_STREAMING_SECONDS ?? 60)
assert.ok(Number.isInteger(seconds) && seconds > 0 && seconds <= 60)
assert.ok(["websockets", "webrtc"].includes(mode))
const chrome = spawn("/usr/bin/chromium", ["--headless=new", "--no-sandbox",
  "--user-data-dir=/tmp/viewer-profile", "--remote-debugging-port=0", "--window-size=1920,1080",
  "--autoplay-policy=no-user-gesture-required", "--disable-dev-shm-usage", "about:blank"],
{ stdio: ["ignore", "ignore", "pipe"] })
let tail = ""
chrome.stderr.on("data", (chunk) => { tail = (tail + chunk).slice(-4096) })
let runtime
try {
  let endpoint
  for (let i=0; i<100; i++) {
    try {
      const [port, path] = (await readFile("/tmp/viewer-profile/DevToolsActivePort", "utf8")).trim().split("\n")
      endpoint = `ws://127.0.0.1:${port}${path}`
      break
    } catch { await delay(100) }
  }
  assert.ok(endpoint, tail)
  runtime = createControlRuntime({ artifacts: "/output/agent", browsers: [{
    id: "private-viewer", name: "Private Linux viewer", kind: "chromium", transport: "direct",
    endpoint: async () => endpoint,
  }] })
  const control = controlClient((action, args) => runtime.call({ action, ...args }, AbortSignal.timeout(90000)))
  await control.connectBrowser("private-viewer")
  // Only a private headless browser exists here. Its active tab must render;
  // Mako's normal background-tab default correctly suspends rAF otherwise.
  const tab = await control.openTab({ browser: "private-viewer", url: "about:blank", background: false })
  await tab.cdp("Network.enable", {})
  await tab.cdp("Network.setExtraHTTPHeaders", { headers: {
    Authorization: `Basic ${Buffer.from(await readFile("/tmp/viewer-auth", "utf8")).toString("base64")}`,
  } })
  await tab.cdp("Page.addScriptToEvaluateOnNewDocument", { source: `
    window.__SELKIES_STREAMING_MODE__=${JSON.stringify(mode)};
    window.fixtureErrors=[];addEventListener('error',e=>fixtureErrors.push(e.message));
  ` })
  await tab.navigate("http://127.0.0.1:8080/")
  await delay(7000)
  const inspect = async (expression) => {
    const response = await tab.cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })
    assert.equal(response.exceptionDetails, undefined, JSON.stringify(response.exceptionDetails))
    return response.result.value
  }
  const initial = await inspect(`({title:document.title,visibility:document.visibilityState,text:document.body.innerText.slice(0,1200),errors:fixtureErrors,media:[...document.querySelectorAll('canvas,video')].map(e=>({tag:e.tagName,id:e.id,width:e.width,height:e.height,videoWidth:e.videoWidth,videoHeight:e.videoHeight}))})`)
  await writeFile("/output/viewer-initial.json", JSON.stringify(initial, null, 2))
  const resourcesBefore = { cpu: await readFile("/sys/fs/cgroup/cpu.stat", "utf8"), memory: await readFile("/sys/fs/cgroup/memory.current", "utf8") }
  await inspect(`(()=>{
    const sample=document.createElement('canvas');sample.width=1920;sample.height=2;
    const ctx=sample.getContext('2d',{willReadFrequently:true});
    const began=performance.now(),seen=[],errors=[];let invalid=0,last;
    window.makoStreamingProbe={elapsedMs:0,seen,invalid,errors,source:false,done:false};
    function tick(){const now=performance.now();
      const visible=[...document.querySelectorAll('video,canvas')].filter(e=>getComputedStyle(e).display!=='none'&&getComputedStyle(e).visibility!=='hidden'&&e.getBoundingClientRect().width>0);
      const source=visible.find(e=>e.tagName==='VIDEO'&&e.videoWidth===1920&&e.videoHeight===1080)||visible.find(e=>e.tagName==='CANVAS'&&e.width===1920&&e.height===1080);
      if(source)try{ctx.drawImage(source,0,450,1920,2,0,0,1920,2);const pixels=ctx.getImageData(0,0,1920,1).data,words=[];
        for(let byte=0;byte<6;byte++){let word=0;for(let bit=0;bit<8;bit++)word=word<<1|(pixels[((byte*8+bit)*40+20)*4]>127?1:0);words.push(word)}
        if(words[4]!==165||words[5]!==words.slice(0,5).reduce((a,b)=>a^b,0))invalid++;
        else{const sequence=words[0]*256+words[1];if(sequence!==last){seen.push({sequence,at:now-began});last=sequence}}
      }catch(e){if(errors.length<10)errors.push(String(e))}
      Object.assign(window.makoStreamingProbe,{elapsedMs:now-began,invalid,source:source?.id,done:now-began>=${seconds * 1000}});
      if(now-began<${seconds * 1000})requestAnimationFrame(tick);
    }tick()
    return true;
  })()`)
  const samples = []
  let result
  for (let i=0; i<70; i++) {
    await delay(1000)
    const state = await inspect(`window.makoStreamingProbe && ({elapsedMs:makoStreamingProbe.elapsedMs,frames:makoStreamingProbe.seen.length,invalid:makoStreamingProbe.invalid,done:makoStreamingProbe.done})`)
    assert.ok(state, "Viewer document changed during measurement")
    samples.push({ ...state, cpu: await readFile("/sys/fs/cgroup/cpu.stat", "utf8"), memory: await readFile("/sys/fs/cgroup/memory.current", "utf8") })
    await writeFile("/output/viewer-progress.json", JSON.stringify(samples, null, 2))
    if (state.done) { result = await inspect("window.makoStreamingProbe"); break }
  }
  assert.ok(result, "Viewer clock did not complete")
  const resourcesAfter = { cpu: await readFile("/sys/fs/cgroup/cpu.stat", "utf8"), memory: await readFile("/sys/fs/cgroup/memory.current", "utf8") }
  await writeFile("/output/viewer-result.json", JSON.stringify({ mode, scope: "Private headless Chromium decoded-pixel oracle; no physical scanout or network-distance claim", resourcesBefore, resourcesAfter, ...result }, null, 2))
  assert.ok(result.seen.length > 100, JSON.stringify(initial))
  assert.equal(result.invalid, 0)
  console.log(JSON.stringify({ mode, distinctFps: result.seen.length * 1000 / result.elapsedMs, invalid: result.invalid }))
} catch (error) {
  await writeFile("/output/viewer-failure.json", JSON.stringify({ message: String(error), browserStderr: tail,
    memoryEvents: await readFile("/sys/fs/cgroup/memory.events", "utf8") }, null, 2))
  throw error
} finally {
  await runtime?.close()
  chrome.kill("SIGTERM")
}
