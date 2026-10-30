import { request, type IncomingMessage } from "node:http"
import {
  CONTROL_VIDEO_BATCH_LIMIT,
  CONTROL_VIDEO_BATCH_TYPE,
  PREVIEW_MEDIA_TYPE,
  collectPreviewMedia,
  decodeControlVideoBatch,
} from "@mako/control-runtime/contracts"
import { RuntimeReplySchema } from "../contracts/runtime.js"
import {
  HOST_CLOSED_CODE,
  HOST_RESTARTING_CODE,
  RuntimeDisconnectedError,
} from "../contracts/host-connection.js"
import {
  readRuntimeResponse,
  type RuntimeTransfer,
} from "./response.js"

interface MediaRead<Value> {
  accept: string
  read(response: IncomingMessage): Promise<{ value: Value; bytes: number }>
  timeoutMs: number
  /** What a timeout or a host that answered without the media type says. */
  name: string
}

/** Read-only media uses the same private socket/client and registered host call.
 * It never enters the general JSON value parser or changes control retry rules. */
function requestRuntimeMedia<Value>(
  socket: string,
  client: string,
  /** The call, encoded by `encodeRuntimeCall`. */
  body: string,
  media: MediaRead<Value>,
  onTransfer?: (transfer: RuntimeTransfer) => void
) {
  return new Promise<Value>((resolve, reject) => {
    const req = request(
      {
        // Its own connection, as every call's (`OWN_CONNECTION`, `connection.ts`): a kept one the host closed while held is no outage.
        agent: false,
        socketPath: socket,
        path: "/rpc",
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: media.accept,
          "x-mako-window": client,
        },
      },
      (response) => {
        void (async () => {
          if (response.statusCode === 503)
            throw new RuntimeDisconnectedError(false)
          if (response.statusCode !== 200)
            throw new Error(`Mako ${media.name} returned ${response.statusCode}`)
          if (response.headers["content-type"] !== media.accept) {
            const reply = RuntimeReplySchema.parse(
              JSON.parse((await readRuntimeResponse(response)).body)
            )
            if (!reply.ok) {
              if (reply.code === HOST_RESTARTING_CODE)
                throw new RuntimeDisconnectedError(true)
              if (reply.code === HOST_CLOSED_CODE)
                throw new RuntimeDisconnectedError(false)
              throw new Error(reply.error)
            }
            throw new Error(
              `${media.name} requires a matching Mako client and host. Existing agents have not been restarted.`
            )
          }
          if (
            response.headers["content-encoding"] &&
            response.headers["content-encoding"] !== "identity"
          )
            throw new Error(`Unexpected ${media.name} content encoding`)
          const { value, bytes } = await media.read(response)
          try {
            onTransfer?.({
              encoding: "binary",
              wireBytes: bytes,
              decodedBytes: bytes,
            })
          } catch {
            /* Diagnostics never change a successful read. */
          }
          return value
        })()
          .then(resolve, reject)
          .finally(() => {
            if (!response.complete) response.destroy()
          })
      }
    )
    req.setTimeout(media.timeoutMs, () =>
      req.destroy(new Error(`${media.name} timed out`))
    )
    req.on("error", reject)
    req.end(body)
  })
}

export function requestRuntimePreview(
  socket: string,
  client: string,
  body: string,
  onTransfer?: (transfer: RuntimeTransfer) => void
) {
  return requestRuntimeMedia(socket, client, body, {
    accept: PREVIEW_MEDIA_TYPE,
    name: "Preview delivery",
    timeoutMs: 5000,
    read: async (response) => {
      const { preview, bytes } = await collectPreviewMedia(response)
      return { value: preview, bytes }
    },
  }, onTransfer)
}

/**
 * One read of a viewer's video, which the host holds up to a second while nothing is sent: the batch's bytes, checked,
 * left whole so they cross to a window as one buffer (`decodeControlVideoBatch` reads them there).
 */
export function requestRuntimeVideo(socket: string, client: string, body: string): Promise<Uint8Array<ArrayBuffer>> {
  return requestRuntimeMedia(socket, client, body, {
    accept: CONTROL_VIDEO_BATCH_TYPE,
    name: "Preview video",
    timeoutMs: 10_000,
    read: async (response) => {
      const declared = Number(response.headers["content-length"])
      if (!Number.isSafeInteger(declared) || declared < 0 || declared > CONTROL_VIDEO_BATCH_LIMIT)
        throw new Error("Invalid preview video length")
      const bytes = new Uint8Array(declared)
      let length = 0
      for await (const chunk of response) {
        const part: Uint8Array = chunk
        if (length + part.byteLength > declared) throw new Error("Invalid preview video length")
        bytes.set(part, length)
        length += part.byteLength
      }
      if (length !== declared) throw new Error("Truncated preview video")
      decodeControlVideoBatch(bytes)
      return { value: bytes, bytes: length }
    },
  })
}
