import { createServer } from "node:http"
import type { Socket } from "node:net"
import { z } from "zod"

/** All a refusal reads of the request it answers. */
const RefusedRequest = z.object({ requestId: z.string() })

// Apart from the session's server (`control-session-server.ts`), which holds the whole of Local Control: a launch
// refuses a connection with this alone (`desktop-session.ts`), and loads none of that until its first use.
/** Answer each request on a connection with a fault; nothing reaches an engine. */
export function refuseControlConnection(connection: Socket, fault: { code: string; message: string }) {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    let bytes = 0
    request.on("data", (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > 1024 * 1024) request.destroy()
      else chunks.push(chunk)
    })
    request.once("end", () => {
      let requestId = "invalid"
      try {
        requestId = RefusedRequest.parse(JSON.parse(Buffer.concat(chunks).toString("utf8"))).requestId
      } catch { /* a malformed request still gets its refusal */ }
      response
        .writeHead(200, { "content-type": "application/json", connection: "close" })
        .end(JSON.stringify({ ok: false, requestId, fault: { ...fault, outcome: "not-dispatched" } }))
    })
  })
  connection.once("close", () => server.close())
  server.emit("connection", connection)
  connection.resume()
}
