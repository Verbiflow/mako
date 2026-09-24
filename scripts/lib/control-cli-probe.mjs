import { z } from "zod"
import { spawn } from "node:child_process"
import { pathToFileURL, fileURLToPath } from "node:url"
import { join } from "node:path"

/** Acceptance helper: every request launches the real CLI against a task worker. */
export class ControlCliProbe {
  constructor({ name }) {
    this.name = name
  }
  async start({
    native,
    browser,
    executable = process.execPath,
    env = process.env,
    runtimeRoot = fileURLToPath(
      new URL("../../packages/control-runtime/dist", import.meta.url)
    ),
  } = {}) {
    const { startDesktopControlSession } = await import(
      pathToFileURL(join(runtimeRoot, "desktop-session.js")).href
    )
    this.session = await startDesktopControlSession(
      { taskId: this.name, native, browser },
      { executable, env }
    )
  }
  async request({ method, arguments: args = {} }, options = {}) {
    if (!this.session) throw new Error("Start the CLI probe before a request")
    const argv =
      method === "exec"
        ? ["exec", "--source-file", "-"]
        : method === "help"
          ? ["api", "--input", "-"]
          : method === "status"
            ? ["status"]
            : null
    if (!argv) throw new Error(`Unknown CLI probe command: ${method}`)
    if (method === "exec")
      args = z.object({ source: z.string() }).strict().parse(args)
    const child = spawn(this.session.launch.command, argv, {
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stdout = "",
      stderr = ""
    child.stdout.on("data", (bytes) => {
      stdout += bytes
    })
    child.stderr.on("data", (bytes) => {
      stderr += bytes
    })
    const cancel = () => child.kill("SIGINT")
    const timeout = setTimeout(cancel, options.timeout ?? 70000)
    options.signal?.addEventListener("abort", cancel, { once: true })
    if (options.signal?.aborted) cancel()
    child.stdin.on("error", () => {})
    child.stdin.end(method === "exec" ? args.source : JSON.stringify(args))
    try {
      const code = await new Promise((done, reject) => {
        child.once("error", reject)
        child.once("close", done)
      })
      if (code !== 0) {
        if (stdout)
          throw new Error(`Unexpected stdout on failed command: ${stdout}`)
        const fault = JSON.parse(stderr)
        return {
          isError: true,
          structuredContent: fault,
          content: [{ type: "text", text: JSON.stringify(fault) }],
        }
      }
      if (stderr) throw new Error(`Unexpected CLI stderr: ${stderr}`)
      const value = JSON.parse(stdout)
      return {
        content:
          method === "exec"
            ? value.map((block) =>
                block.type === "result"
                  ? { type: "text", text: JSON.stringify(block.value) }
                  : block
              )
            : [{ type: "text", text: JSON.stringify(value) }],
      }
    } finally {
      clearTimeout(timeout)
      options.signal?.removeEventListener("abort", cancel)
    }
  }
  async close() {
    await this.session?.close()
  }
}
