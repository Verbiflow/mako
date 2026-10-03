import { createServer } from "node:net"

/** Package probes stay within the active Thread's allocation, when present. */
export async function threadDebugPort() {
  const allocation = process.env.MAKO_THREAD_PORTS
  if (!allocation) return 0
  const primary = Number(process.env.MAKO_THREAD_PORT)
  const declared = allocation.match(/\d+/g)?.map(Number) ?? []
  const ports = declared.length === 1 && declared[0] <= 100 && Number.isInteger(primary)
    ? Array.from({ length: declared[0] }, (_, offset) => primary + offset)
    : declared
  for (const port of ports) {
    if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === primary) continue
    const available = await new Promise((resolve, reject) => {
      const server = createServer()
      server.once("error", (error) => error.code === "EADDRINUSE" ? resolve(false) : reject(error))
      server.listen(port, "127.0.0.1", () => server.close((error) => error ? reject(error) : resolve(true)))
    })
    if (available) return port
  }
  throw new Error("No allocated Thread port is free for the package probe. Existing processes were left running.")
}
