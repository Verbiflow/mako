// Private fixture: production state, bridge and component; no app session or providers.
import { createRoot } from "react-dom/client"
import { ControlPreviewOverlay } from "../src/components/inspector/control-preview-overlay"
import { getMako } from "../src/lib/bridge"
import {
  controlPreviewStore,
  receiveControlActivity,
} from "../src/state/control-preview"
import "../src/index.css"

getMako().onEvent((event) => {
  if (event.type === "control-activity") receiveControlActivity(event.activity)
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
    fidelity: async () => {
      const frame = controlPreviewStore.get().previews["preview-audit"]?.frame
      if (!frame) throw new Error("Missing retained frame")
      const image = new Image()
      const url = URL.createObjectURL(new Blob([frame.image.bytes], { type: frame.image.mimeType }))
      image.src = url
      try { await image.decode() } finally { URL.revokeObjectURL(url) }
      return Array.from(document.querySelectorAll("canvas"), (canvas) => {
        const box = canvas.getBoundingClientRect()
        const scale = Math.min(
          (box.width * devicePixelRatio) / image.naturalWidth,
          (box.height * devicePixelRatio) / image.naturalHeight,
          1
        )
        const displayed = [Math.round(image.naturalWidth * scale), Math.round(image.naturalHeight * scale)]
        const reference = document.createElement("canvas")
        reference.width = canvas.width
        reference.height = canvas.height
        const context = reference.getContext("2d")!
        context.imageSmoothingQuality = "high"
        context.drawImage(image, 0, 0, canvas.width, canvas.height)
        const expected = context.getImageData(0, 0, canvas.width, canvas.height).data
        const actual = canvas
          .getContext("2d")!
          .getImageData(0, 0, canvas.width, canvas.height).data
        let sum = 0,
          squares = 0,
          largest = 0
        for (let i = 0; i < expected.length; i++) {
          if (i % 4 === 3) continue
          const difference = Math.abs(expected[i]! - actual[i]!)
          sum += difference
          squares += difference * difference
          largest = Math.max(largest, difference)
        }
        const channels = (expected.length / 4) * 3
        return {
          width: canvas.width,
          height: canvas.height,
          displayed,
          sourceWidth: image.naturalWidth,
          sourceHeight: image.naturalHeight,
          meanAbsolute: sum / channels,
          largestDifference: largest,
          // Identical pixels report 100 dB so the value survives JSON.
          psnr: squares ? 10 * Math.log10((255 * 255 * channels) / squares) : 100,
          bytes: actual.length,
        }
      })
    },
  },
})
