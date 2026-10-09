import { lazyPackage } from "@mako/lazy"

/**
 * The heavy packages the control runtime uses, each loaded the first time a
 * session needs it, so a worker or host that never encodes an image or drives
 * a computer never loads them. The host loads these same declarations, so each
 * package is recorded once per process. Nothing else imports these packages:
 * the `mako/heavy-packages` lint rule holds that.
 */
export const heavy = {
  /** sharp, and the native image library it opens as it loads, at the first image. */
  sharp: lazyPackage("sharp", () => import("sharp").then((module) => module.default)),
  ws: lazyPackage("ws", () => import("ws")),
  mcpTypes: lazyPackage("@modelcontextprotocol/sdk/types.js", () => import("@modelcontextprotocol/sdk/types.js")),
  /** MCP's client, its stdio transport and the driver schema's validator (ajv): a driver needs all three. */
  mcpClient: lazyPackage("@modelcontextprotocol/sdk client (driver-schema.ts)", () =>
    Promise.all([
      import("@modelcontextprotocol/sdk/client/index.js"),
      import("@modelcontextprotocol/sdk/client/stdio.js"),
      import("./driver-schema.js"),
    ]).then(([{ Client }, { StdioClientTransport }, { driverSchemaValidator }]) => ({ Client, StdioClientTransport, driverSchemaValidator }))),
}
