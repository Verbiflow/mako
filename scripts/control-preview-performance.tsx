// Private fixture: production state, bridge and component; no app session or providers.
import { createRoot } from "react-dom/client"
import { ControlPreviewOverlay } from "../src/components/inspector/control-preview-overlay"
import { getMako } from "../src/lib/bridge"
import { controlPreviewDemand } from "../src/lib/control-preview-decoder"
import {
  controlPreviewStore,
  receiveControlActivity,
} from "../src/state/control-preview"
import "../src/index.css"

// Stage trace on the wall clock the audit's main process also uses, so a
// compositor freeze can be attributed to the viewer stage that went quiet.
const wall = () => performance.timeOrigin + performance.now()
const stages = {
  notified: [] as number[],
  stored: [] as { at: number; id: string; capturedAt: number; publishedAt: number }[],
  decoded: [] as { at: number; ms: number }[],
  drawn: [] as number[],
  lagged: [] as { at: number; ms: number }[],
}
if ("ImageDecoder" in globalThis) {
  const decode = ImageDecoder.prototype.decode
  ImageDecoder.prototype.decode = function (this: ImageDecoder, options) {
    const started = wall()
    return decode.call(this, options).then((result) => {
      const at = wall()
      stages.decoded.push({ at, ms: at - started })
      return result
    })
  }
}
const drawImage = CanvasRenderingContext2D.prototype.drawImage
CanvasRenderingContext2D.prototype.drawImage = function (
  this: CanvasRenderingContext2D,
  ...args: Parameters<typeof drawImage>
) {
  if (this.canvas.isConnected) stages.drawn.push(wall())
  return drawImage.apply(this, args)
}
let tick = performance.now()
setInterval(() => {
  const now = performance.now()
  if (now - tick > 60) stages.lagged.push({ at: wall(), ms: now - tick - 20 })
  tick = now
}, 20)
let storedId: string | undefined
controlPreviewStore.subscribe(() => {
  const frame = controlPreviewStore.get().previews["preview-audit"]?.frame
  if (!frame || frame.id === storedId) return
  storedId = frame.id
  stages.stored.push({ at: wall(), id: frame.id, capturedAt: frame.capturedAt, publishedAt: frame.publishedAt })
})

getMako().onEvent((event) => {
  if (event.type !== "control-activity") return
  stages.notified.push(wall())
  receiveControlActivity(event.activity)
})
createRoot(document.getElementById("root")!).render(
  <>
    <div style={{ position: "relative", width: 640, height: 240 }}>
      <ControlPreviewOverlay conversationId="preview-audit" />
    </div>
    {new URLSearchParams(location.search).get("viewers") === "2" && (
      <div style={{ position: "relative", width: 640, height: 240 }}>
        <ControlPreviewOverlay conversationId="preview-audit" />
      </div>
    )}
  </>
)

// Called only after the fixture has stopped animating. Each viewer must hold
// exactly its displayed device pixels, matching an independent full-resolution
// decode of the same retained frame downscaled with high-quality smoothing.
Object.assign(window, {
  previewAudit: {
    trace: () => stages,
    demand: () => controlPreviewDemand() ?? null,
    // `capture`: the same page's full-resolution frame as base64 JPEG, when
    // the host sent the viewer a scaled one.
    fidelity: async (capture?: string) => {
      const frame = controlPreviewStore.get().previews["preview-audit"]?.frame
      if (!frame) throw new Error("Missing retained frame")
      const decode = async (bytes: Uint8Array<ArrayBuffer>, mimeType: string) => {
        const image = new Image()
        const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }))
        image.src = url
        try { await image.decode() } finally { URL.revokeObjectURL(url) }
        return image
      }
      const image = await decode(frame.image.bytes, frame.image.mimeType)
      const full = capture
        ? await decode(Uint8Array.from(atob(capture), (c) => c.charCodeAt(0)), "image/jpeg")
        : undefined
      const compare = (canvas: HTMLCanvasElement, source: HTMLImageElement) => {
        const reference = document.createElement("canvas")
        reference.width = canvas.width
        reference.height = canvas.height
        const context = reference.getContext("2d")!
        context.imageSmoothingQuality = "high"
        context.drawImage(source, 0, 0, canvas.width, canvas.height)
        const expected = context.getImageData(0, 0, canvas.width, canvas.height).data
        const actual = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data
        let sum = 0, squares = 0, largest = 0
        for (let i = 0; i < expected.length; i++) {
          if (i % 4 === 3) continue
          const difference = Math.abs(expected[i]! - actual[i]!)
          sum += difference
          squares += difference * difference
          largest = Math.max(largest, difference)
        }
        const channels = (expected.length / 4) * 3
        return {
          meanAbsolute: sum / channels,
          largestDifference: largest,
          // Identical pixels report 100 dB so the value survives JSON.
          psnr: squares ? 10 * Math.log10((255 * 255 * channels) / squares) : 100,
          bytes: actual.length,
        }
      }
      return Array.from(document.querySelectorAll("canvas"), (canvas) => {
        const box = canvas.getBoundingClientRect()
        const scale = Math.min(
          (box.width * devicePixelRatio) / image.naturalWidth,
          (box.height * devicePixelRatio) / image.naturalHeight,
          1
        )
        const displayed = [Math.round(image.naturalWidth * scale), Math.round(image.naturalHeight * scale)]
        return {
          frameId: frame.id,
          box: [box.width * devicePixelRatio, box.height * devicePixelRatio],
          width: canvas.width,
          height: canvas.height,
          displayed,
          sourceWidth: image.naturalWidth,
          sourceHeight: image.naturalHeight,
          ...compare(canvas, image),
          capture: full && { width: full.naturalWidth, height: full.naturalHeight, ...compare(canvas, full) },
        }
      })
    },
  },
})
