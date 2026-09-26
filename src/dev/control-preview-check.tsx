// Explicit regression fixture. Never imported by the desk.
import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"
import { ControlPreviewOverlay } from "@/components/inspector/control-preview-overlay"
import type { ControlPreview } from "@/lib/types"
import { getMako } from "@/lib/bridge"
import {
  controlPreviewStore,
  receiveControlActivity,
  watchControlPreview,
} from "@/state/control-preview"
import { installMockBridge } from "./mock-bridge"
import "../index.css"

installMockBridge()
const source = new URLSearchParams(location.search).get("source")
const canvas = document.createElement("canvas")
canvas.width = 640
canvas.height = 360
const painter = canvas.getContext("2d")!
painter.fillRect(0, 0, 640, 360)
let image: NonNullable<ControlPreview["frame"]>["image"] = {
  mimeType: "image/png",
  bytes: Uint8Array.from(atob(canvas.toDataURL().split(",")[1]!), char => char.charCodeAt(0)),
}
const bridge = getMako()
let frame = 0
bridge.nativeWindowVideo = Boolean(source)
bridge.controlPreviewSource = async () => source
bridge.controlPreview = async (id) => ({
  activity: {
    conversationId: id,
    kind: source && id === "one" ? "computer" : "browser",
    operation: "observe",
    status: "running",
    target: id,
    updatedAt: 1,
  },
  frame: { id: `${id}:${frame++}`, image, capturedAt: Date.now() },
  window: source && id === "one" ? { pid: 1, windowId: 1 } : undefined,
})
const container = document.getElementById("root")!
container.className = "p-8"
const output = document.createElement("pre")
output.id = "result"
output.textContent = "Running"
const panes = document.createElement("div")
panes.className = "flex gap-4"
container.append(output, panes)
const root = createRoot(panes)
function render(second: boolean) {
  flushSync(() =>
    root.render(
      <>
        <div
          data-pane="one"
          style={{ height: 384, width: 384 }}
          className="relative overflow-hidden border border-border"
        >
          <ControlPreviewOverlay conversationId="one" />
        </div>
        {second && (
          <div
            data-pane="two"
            style={{ height: 384, width: 384 }}
            className="relative overflow-hidden border border-border"
          >
            <ControlPreviewOverlay conversationId="two" />
          </div>
        )}
      </>
    )
  )
}
function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message)
  output.textContent += `\nPASS ${message}`
}
async function until(test: () => boolean) {
  const deadline = Date.now() + 12_000
  while (!test()) {
    if (Date.now() > deadline) throw new Error("Preview fixture timed out")
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}
async function run() {
  receiveControlActivity({
    conversationId: "one",
    kind: "browser",
    operation: "observe",
    status: "running",
    target: "one",
    updatedAt: 1,
  })
  receiveControlActivity({
    conversationId: "two",
    kind: "browser",
    operation: "observe",
    status: "running",
    target: "two",
    updatedAt: 1,
  })
  render(true)
  await until(() => panes.querySelectorAll("section").length === 2)
  for (const pane of panes.querySelectorAll("[data-pane]")) {
    const bounds = pane.getBoundingClientRect()
    const preview = pane.querySelector("section")!.getBoundingClientRect()
    check(
      preview.left >= bounds.left &&
        preview.right <= bounds.right &&
        preview.top >= bounds.top &&
        preview.bottom <= bounds.bottom,
      `Preview stays within task ${pane.getAttribute("data-pane")}`
    )
  }
  check(
    controlPreviewStore.get().previews.one?.activity.conversationId === "one" &&
      controlPreviewStore.get().previews.two?.activity.conversationId === "two",
    "Two tasks retain their own frames"
  )
  const closeInspector = watchControlPreview("one")
  closeInspector()
  check(
    Boolean(controlPreviewStore.get().previews.one),
    "Closing another consumer preserves the chat preview"
  )
  render(false)
  await until(() => !controlPreviewStore.get().previews.two)
  check(
    Boolean(controlPreviewStore.get().previews.one),
    "Closing another task preserves this task"
  )
  if (source) {
    const video = panes.querySelector("video")!
    await until(() => video.videoWidth > 0)
    const time = video.currentTime
    await until(() => video.currentTime > time + 0.5)
    check(
      video.videoWidth > 0,
      "Native window video advances in the production chat preview"
    )
  }
  panes.querySelector<HTMLButtonElement>('[aria-label="Hide preview"]')!.click()
  await until(() => !panes.querySelector("section"))
  check(
    !controlPreviewStore.get().previews.one,
    "Dismissal releases the preview frame"
  )
  check(
    Boolean(panes.querySelector("button")),
    "Dismissed preview can be reopened inside the same task"
  )
  if (!source) {
    const large = document.createElement("canvas")
    large.width = 1920
    large.height = 1080
    const draw = large.getContext("2d")!
    draw.fillStyle = "#2a6"
    draw.fillRect(0, 0, 1920, 1080)
    draw.fillStyle = "#fff"
    draw.font = "96px sans-serif"
    draw.fillText("1920 × 1080 source", 120, 540)
    const blob = await new Promise<Blob>((resolve) => large.toBlob((value) => resolve(value!), "image/jpeg", 0.9))
    image = { mimeType: "image/jpeg", bytes: new Uint8Array(await blob.arrayBuffer()) }
    const displayed = () => {
      const viewer = panes.querySelector<HTMLCanvasElement>('canvas[role="img"]')
      if (!viewer?.style.aspectRatio) return undefined
      const box = viewer.getBoundingClientRect()
      const scale = Math.min((box.width * devicePixelRatio) / 1920, (box.height * devicePixelRatio) / 1080, 1)
      return { viewer, width: Math.round(1920 * scale), height: Math.round(1080 * scale) }
    }
    const holds = () => {
      const value = displayed()
      return Boolean(value && Math.abs(value.viewer.width - value.width) <= 1 && Math.abs(value.viewer.height - value.height) <= 1)
    }
    panes.querySelector<HTMLButtonElement>("button")!.click()
    await until(holds)
    const { viewer } = displayed()!
    const width = viewer.width
    check(width < 1920, `Viewer holds its displayed device pixels (${width}×${viewer.height} at DPR ${devicePixelRatio})`)
    const reads = frame
    viewer.style.width = "50%"
    await until(() => holds() && viewer.width < width)
    check(frame === reads, `Resizing repaints the held frame at ${displayed()!.viewer.width}×${displayed()!.viewer.height} without another read`)
  }
  output.dataset.status = "passed"
}
void run().catch((error) => {
  output.textContent += `\nFAIL ${String(error)}`
  output.dataset.status = "failed"
})
