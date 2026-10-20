// Explicit regression fixture. Never imported by the desk.
import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"
import { encodeControlVideo, encodeControlVideoBatch, type ControlActivity } from "@mako/control-runtime/contracts"
import { ControlPreviewOverlay } from "@/components/inspector/control-preview-overlay"
import { getMako } from "@/lib/bridge"
import { receiveControlActivity } from "@/state/control-preview"
import { installMockBridge } from "./mock-bridge"
import "../index.css"

// A cloud machine's tab as the desktop receives it: real H.264 from WebCodecs, a poster JPEG for each new viewer, a
// batch per read, and nothing between turns until the agent acts again.
installMockBridge()
const bridge = getMako()
const source = document.createElement("canvas")
source.width = 1280
source.height = 800
const paint = source.getContext("2d")!
let tick = 0
function draw() {
  paint.fillStyle = "#f4f1ea"
  paint.fillRect(0, 0, 1280, 800)
  paint.fillStyle = "#1f2a44"
  paint.fillRect(0, 0, 1280, 72)
  paint.fillStyle = "#fff"
  paint.font = "bold 30px sans-serif"
  paint.fillText("shop.example — Checkout", 32, 47)
  paint.fillStyle = "#3a7bd5"
  paint.fillRect(64, 160, 1152, 300)
  paint.fillStyle = "#e8553d"
  paint.fillRect(64 + ((tick * 12) % 1000), 520, 152, 88)
  paint.fillStyle = "#1f2a44"
  paint.font = "28px sans-serif"
  paint.fillText(`Frame ${tick}`, 64, 700)
}
draw()

const queue: Uint8Array[] = []
const viewers = new Set<string>()
const boxes: ({ width: number; height: number } | undefined)[] = []
let reads = 0
let paused = false
let keyNext = true
let arrived: (() => void) | undefined
const encoder = new VideoEncoder({
  output(chunk, metadata) {
    const data = new Uint8Array(chunk.byteLength)
    chunk.copyTo(data)
    const description = metadata?.decoderConfig?.description
    const common = { width: 1280, height: 800, sequence: chunk.timestamp, capturedAt: Date.now(), data }
    const avcC = description && (ArrayBuffer.isView(description)
      ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength).slice()
      : new Uint8Array(description).slice())
    queue.push(encodeControlVideo(chunk.type === "key" && avcC ? { ...common, kind: "key", description: avcC } : { ...common, kind: "delta" }))
    arrived?.()
  },
  error: (error) => fail(`The fixture's encoder failed: ${error.message}`),
})
encoder.configure({ codec: "avc1.420028", width: 1280, height: 800, avc: { format: "avc" }, latencyMode: "realtime", framerate: 30 })
setInterval(() => {
  if (paused || !viewers.size) return
  tick++
  draw()
  const frame = new VideoFrame(source, { timestamp: tick })
  encoder.encode(frame, { keyFrame: keyNext })
  keyNext = false
  frame.close()
}, 33)
const poster = async () => {
  const blob = await new Promise<Blob>((resolve) => source.toBlob((value) => resolve(value!), "image/jpeg", 0.8))
  return encodeControlVideo({ kind: "poster", width: 1280, height: 800, sequence: tick, capturedAt: Date.now(), data: new Uint8Array(await blob.arrayBuffer()) })
}
const activity = (status: ControlActivity["status"], updatedAt: number): ControlActivity => ({ conversationId: "cloud", kind: "browser", operation: "click", status, target: "Checkout", updatedAt })
bridge.controlPreview = async () => ({ activity: activity(paused ? "observed" : "running", 1), frame: null, video: true, paused: paused || undefined })
bridge.controlVideo = async (_id, viewer, box) => {
  reads++
  boxes.push(box)
  if (!viewers.has(viewer)) {
    // The machine connecting: long enough to see what the card shows meanwhile.
    if (!viewers.size) await new Promise((resolve) => setTimeout(resolve, 900))
    viewers.add(viewer)
    queue.length = 0
    queue.push(await poster())
    keyNext = true
  }
  if (!queue.length && !paused) await new Promise<void>((resolve) => {
    arrived = resolve
    setTimeout(resolve, 1000)
  })
  arrived = undefined
  return encodeControlVideoBatch({ live: !paused, packets: queue.splice(0) })
}

const container = document.getElementById("root")!
container.className = "p-8"
const output = document.createElement("pre")
output.id = "result"
output.textContent = "Running"
const pane = document.createElement("div")
pane.style.height = "520px"
pane.style.width = "640px"
pane.className = "relative overflow-hidden border border-border"
container.append(pane, output)
flushSync(() => createRoot(pane).render(<ControlPreviewOverlay conversationId="cloud" />))

function fail(message: string): never {
  throw new Error(message)
}
function check(condition: boolean, message: string): asserts condition {
  if (!condition) fail(message)
  output.textContent += `\nPASS ${message}`
}
async function until(test: () => boolean, what: string) {
  const deadline = Date.now() + 12_000
  while (!test()) {
    if (Date.now() > deadline) fail(`Timed out waiting until ${what}; reads ${reads}, viewers ${viewers.size}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}
const viewer = () => pane.querySelector<HTMLCanvasElement>('canvas[role="img"]')
const connecting = () => [...pane.querySelectorAll('[role="status"]')].some((node) => node.textContent?.includes("Connecting"))
/** A cheap fingerprint of what the canvas shows: a row through the moving block. */
const picture = () => {
  const canvas = viewer()!
  const row = Math.round(canvas.height * 0.7)
  return [...canvas.getContext("2d")!.getImageData(0, row, canvas.width, 1).data].join(",")
}
const header = () => {
  const canvas = viewer()!
  const [red, green, blue] = canvas.getContext("2d")!.getImageData(Math.round(canvas.width / 2), Math.round(canvas.height * 0.03), 1, 1).data
  return Math.abs(red! - 0x1f) + Math.abs(green! - 0x2a) + Math.abs(blue! - 0x44)
}
const deviceBox = () => {
  const box = viewer()!.getBoundingClientRect()
  return { width: Math.round(box.width * devicePixelRatio), height: Math.round(box.height * devicePixelRatio) }
}
const stage = (name: string) => {
  output.dataset.stage = name
}

async function run() {
  receiveControlActivity(activity("running", 1))
  await until(() => Boolean(viewer()), "the cloud card appears")
  check(connecting(), "Before the machine answers, the card says it is connecting")
  stage("connecting")
  await until(() => !connecting(), "the first picture paints")
  await until(() => header() < 40, "the page's header is drawn")
  const first = picture()
  await until(() => picture() !== first, "the picture moves")
  check(true, "The tab plays as live H.264, decoded and drawn in the card")
  await until(() => boxes.at(-1)?.width === deviceBox().width, "a read carries the card's size")
  const box = deviceBox()
  check(Math.abs(viewer()!.width - box.width) <= 1, `The card draws at its device pixels (${viewer()!.width}×${viewer()!.height}, box ${box.width}×${box.height})`)
  stage("live")
  await new Promise((resolve) => setTimeout(resolve, 600))

  pane.querySelector<HTMLButtonElement>('[aria-label="Enlarge preview"]')!.click()
  await until(() => Boolean(pane.querySelector('[aria-label="Shrink preview"]')), "the card enlarges")
  await until(() => (boxes.at(-1)?.width ?? 0) > box.width && Math.abs(viewer()!.width - deviceBox().width) <= 1, "the enlarged card asks for and draws more pixels")
  check(true, `Enlarged, the card asks for its new size and draws it (${viewer()!.width}×${viewer()!.height})`)
  stage("enlarged")
  await new Promise((resolve) => setTimeout(resolve, 600))
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
  await until(() => Boolean(pane.querySelector('[aria-label="Enlarge preview"]')), "the card returns to its corner")

  paused = true
  receiveControlActivity(activity("observed", 2))
  await until(() => Boolean(pane.querySelector('[aria-label="Control preview, last view"]')), "the card shows the last view")
  await new Promise((resolve) => setTimeout(resolve, 300))
  const held = reads
  const still = picture()
  await new Promise((resolve) => setTimeout(resolve, 2_000))
  check(reads <= held + 1 && picture() === still, "Between turns the card holds its last picture and stops reading")
  stage("paused")
  await new Promise((resolve) => setTimeout(resolve, 600))

  paused = false
  receiveControlActivity(activity("running", 3))
  await until(() => !pane.querySelector('[aria-label="Control preview, last view"]'), "the card is live again")
  await until(() => picture() !== still, "the picture moves again")
  check(true, "The agent's next action resumes the video in the same card")
  stage("resumed")
  output.dataset.status = "passed"
}
void run().catch((error) => {
  output.textContent += `\nFAIL ${String(error)}`
  output.dataset.status = "failed"
})
