import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { UtilityModelError } from "../../utility-model-error.js"
import { spawnProviderProcess } from "../provider-process.js"
import { jsonReply, lightModel, type ProviderUtilityRunner } from "../utility-runner.js"
import { resolveCodexExecutable } from "./executable.js"

/**
 * One prompt through `codex exec` on the account Codex is signed in with.
 * `--ephemeral` keeps the run out of `~/.codex/sessions`, the sandbox is
 * read-only in an empty folder, and the person's MCP servers aren't
 * started. The rest of their configuration stays, since a model provider or
 * an endpoint may live there.
 */
export const codexUtilityRunner: ProviderUtilityRunner = {
  provider: "codex",
  light: lightModel,
  async complete(request) {
    const { resolveAccountLaunch } = await import("../../accounts.js")
    const { env } = await resolveAccountLaunch("codex", process.env)
    const command = await resolveCodexExecutable(env)
    if (!command) throw new UtilityModelError("request", "Codex isn't installed. Install it in Settings › Agents.")
    const folder = await mkdtemp(join(tmpdir(), "mako-utility-"))
    try {
      const reply = join(folder, "reply.txt")
      const args = [
        "exec", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", "--color", "never",
        "--model", request.model,
        "-c", `model_reasoning_effort="${request.reasoning === "high" ? "high" : "low"}"`,
        "-c", "mcp_servers={}",
        "--output-last-message", reply,
      ]
      if (request.schema) {
        const schema = join(folder, "schema.json")
        await writeFile(schema, JSON.stringify(request.schema))
        args.push("--output-schema", schema)
      }
      args.push("-")
      const { code, stderr } = await run(command, args, folder, env, `${request.instructions}\n\n${request.prompt}`, request.signal)
      if (request.signal.aborted) throw new UtilityModelError("timeout", "The request was cancelled or timed out.")
      const text = (await readFile(reply, "utf8").catch(() => "")).trim()
      if (code !== 0 || !text) throw codexFailure(stderr, code)
      return request.schema ? jsonReply(text) : text
    } finally {
      await rm(folder, { recursive: true, force: true })
    }
  },
}

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, input: string, signal: AbortSignal): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawnProviderProcess(command, args, { cwd, env, signal, windowsHide: true })
    let stderr = ""
    // Codex prints its progress to stderr; the tail is enough to explain a failure.
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8_000) })
    child.stdout.resume()
    child.once("error", (error) => { if (signal.aborted) resolve({ code: null, stderr }); else reject(error) })
    child.once("close", (code) => resolve({ code, stderr }))
    child.stdin.end(input)
  })
}

function codexFailure(stderr: string, code: number | null): UtilityModelError {
  if (/not logged in|log ?in|sign ?in|unauthori[sz]ed|401\b|403\b|refresh token|auth/i.test(stderr))
    return new UtilityModelError("auth", "Codex isn't signed in, or its sign-in expired. Run `codex login`, then try again.")
  if (/rate.?limit|usage limit|quota|429\b/i.test(stderr))
    return new UtilityModelError("rate-limit", "Codex's usage limit was reached. Mako tries again later.")
  if (/context.{0,20}(window|length|limit)|too (long|large)/i.test(stderr))
    return new UtilityModelError("context", "The request exceeds this model's context window.")
  if (/model.{0,40}(not (found|supported|available))|unknown model/i.test(stderr))
    return new UtilityModelError("request", "Codex doesn't offer this model on this account. Choose another in Settings.")
  return new UtilityModelError("request", `Codex couldn't answer the request${code === null ? "" : ` (exit ${code})`}.`)
}
