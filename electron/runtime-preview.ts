import { request } from "node:http"
import { PREVIEW_MEDIA_TYPE, collectPreviewMedia } from "@mako/control-runtime/contracts"
import { RuntimeReplySchema, type RuntimeCall } from "./contracts/runtime.js"
import { HOST_CLOSED_CODE, HOST_RESTARTING_CODE, RuntimeDisconnectedError } from "./contracts/host-connection.js"
import { readRuntimeResponse, type RuntimeTransfer } from "./runtime-response.js"

/** Read-only media uses the same private socket/client and registered host call.
 * It never enters the general JSON value parser or changes control retry rules. */
export function requestRuntimePreview(socket: string, client: string, body: RuntimeCall,
  onTransfer?: (transfer: RuntimeTransfer) => void) {
  return new Promise<Awaited<ReturnType<typeof collectPreviewMedia>>["preview"]>((resolve, reject) => {
    const req = request({ socketPath: socket, path: "/rpc", method: "POST",
      headers: { "content-type": "application/json", accept: PREVIEW_MEDIA_TYPE, "x-mako-window": client },
    }, response => {
      void (async () => {
        if (response.statusCode === 503) throw new RuntimeDisconnectedError(false)
        if (response.statusCode !== 200) throw new Error(`Mako preview returned ${response.statusCode}`)
        if (response.headers["content-type"] !== PREVIEW_MEDIA_TYPE) {
          const reply = RuntimeReplySchema.parse(JSON.parse((await readRuntimeResponse(response)).body))
          if (!reply.ok) {
            if (reply.code === HOST_RESTARTING_CODE) throw new RuntimeDisconnectedError(true)
            if (reply.code === HOST_CLOSED_CODE) throw new RuntimeDisconnectedError(false)
            throw new Error(reply.error)
          }
          throw new Error("Preview delivery requires a matching Mako client and host. Existing agents have not been restarted.")
        }
        if (response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity")
          throw new Error("Unexpected preview content encoding")
        const value = await collectPreviewMedia(response)
        try { onTransfer?.({ encoding: "binary", wireBytes: value.bytes, decodedBytes: value.bytes }) }
        catch { /* Diagnostics never change a successful read. */ }
        return value.preview
      })().then(resolve, reject).finally(() => { if (!response.complete) response.destroy() })
    })
    req.setTimeout(5000, () => req.destroy(new Error("Preview delivery timed out")))
    req.on("error", reject)
    req.end(JSON.stringify(body))
  })
}
