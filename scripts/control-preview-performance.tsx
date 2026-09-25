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

// Called only after the fixture has stopped animating. Compares every source
// pixel after JPEG decoding; no rescale, pixel tolerance or screenshot oracle.
Object.assign(window, {
  previewAudit: {
    fidelity: async () => {
      const frame = controlPreviewStore.get().previews["preview-audit"]?.frame
      if (!frame) throw new Error("Missing retained frame")
      const image = new Image()
      const url = URL.createObjectURL(new Blob([frame.image.bytes], { type: frame.image.mimeType }))
      image.src = url
      try { await image.decode() } finally { URL.revokeObjectURL(url) }
      const reference = document.createElement("canvas")
      reference.width = image.naturalWidth
      reference.height = image.naturalHeight
      const context = reference.getContext("2d")!
      context.drawImage(image, 0, 0)
      const expected = context.getImageData(
        0,
        0,
        reference.width,
        reference.height
      ).data
      return Array.from(document.querySelectorAll("canvas"), (canvas) => {
        if (
          canvas.width !== reference.width ||
          canvas.height !== reference.height
        )
          throw new Error(
            "Viewer dimensions differ from the decoded source image"
          )
        const actual = canvas
          .getContext("2d")!
          .getImageData(0, 0, canvas.width, canvas.height).data
        let differences = 0
        for (let i = 0; i < expected.length; i++)
          if (expected[i] !== actual[i]) differences++
        return {
          width: canvas.width,
          height: canvas.height,
          differences,
          bytes: actual.length,
        }
      })
    },
  },
})
