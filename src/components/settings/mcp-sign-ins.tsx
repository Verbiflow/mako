import { mcpServerUnreachable, type McpSignIn } from "@mako/host/contracts/mcp-sign-ins"
import { harnessLabel } from "@/lib/harness-label"
import { cn } from "@/lib/utils"
import { signInMcp, useMcpSignIns } from "@/state/mcp-sign-ins"

const ACTION = "pressable -my-0.5 h-5 shrink-0 px-1.5 text-label font-medium text-foreground/80 hover:bg-fill-hover hover:text-foreground disabled:opacity-50"

function openMcpSettings() {
  window.dispatchEvent(new CustomEvent("mako:settings", { detail: "mcp" }))
}

/** The one thing that fixes it, in its words: "Sign in to todoist", "Signing in…", or "Try again" after one that didn't finish. */
function SignInButton({ server, className }: { server: McpSignIn; className?: string }) {
  const signing = server.state?.kind === "signing-in"
  return (
    <button
      type="button"
      data-mcp-sign-in={server.server}
      disabled={signing}
      title={serverLine(server)}
      onClick={() => void signInMcp(server)}
      className={cn(ACTION, className)}
    >
      {signing ? "Signing in…" : server.state?.kind === "failed" ? "Try again" : `Sign in to ${server.server}`}
    </button>
  )
}

/** Why it's said: the harness that couldn't start it, and what fixes it. */
function serverLine(server: McpSignIn): string {
  const harness = harnessLabel(server.harness)
  if (server.state?.kind === "failed") return `${server.state.reason} ${harness} still can't reach ${server.server}.`
  if (server.way !== "settings") return `${harness} can't use ${server.server} until you sign in${server.way === "page" ? " on its page" : ""}.`
  if (mcpServerUnreachable(server)) return `${harness} couldn't reach ${server.server} (${server.reason}). It tries again with each new session.`
  return `${harness} couldn't start ${server.server}: ${server.reason}. Its entry is below.`
}

/** What the person can act on first; a server that couldn't be reached last. */
function byAction(left: McpSignIn, right: McpSignIn): number {
  return Number(mcpServerUnreachable(left)) - Number(mcpServerUnreachable(right)) || Number(left.way === "settings") - Number(right.way === "settings")
}

/**
 * Settings › MCP: every server a harness couldn't start, each with the one thing that fixes it (its sign-in, or its
 * entry below), and quietly those it couldn't reach. A line goes once it's fixed.
 */
export function McpSignInsList() {
  const servers = useMcpSignIns((state) => state.servers)
  if (!servers.length) return null
  return (
    <section aria-label="Servers that didn't start" className="mb-6 flex flex-col gap-2 pt-4">
      {[...servers].sort(byAction).map((server) =>
        mcpServerUnreachable(server) && server.way === "settings" ? (
          <p key={`${server.harness}\0${server.server}`} data-mcp-unreachable={server.server} className="px-2.5 text-label text-faint">
            {serverLine(server)}
          </p>
        ) : (
          <div key={`${server.harness}\0${server.server}`} data-mcp-server={server.server} className="flex items-center gap-3 bg-raised px-2.5 py-2">
            <span className="min-w-0 flex-1 text-label text-muted-foreground">{serverLine(server)}</span>
            {server.way === "settings" ? null : <SignInButton server={server} />}
          </div>
        )
      )}
    </section>
  )
}

/**
 * Above the rail's footer while a server needs the person: the first with the one thing that fixes it (its sign-in,
 * else Settings › MCP), the rest one press away in Settings › MCP. Said here once, not in every conversation that
 * starts. A server that only couldn't be reached is Settings' alone.
 */
export function McpSignInRailLine({ className }: { className?: string }) {
  const all = useMcpSignIns((state) => state.servers)
  const servers = all.filter((server) => server.way !== "settings" || !mcpServerUnreachable(server)).sort(byAction)
  const first = servers[0]
  if (!first) return null
  const more = servers.length - 1
  return (
    // The rail is narrow: the button says what to do, and its title why (`serverLine`).
    <div data-mcp-sign-ins={servers.length} className={cn("flex items-center gap-2 border-t border-hairline px-3 py-2 text-label text-muted-foreground", className)}>
      {first.way === "settings" ? (
        <>
          <span className="min-w-0 flex-1 truncate" title={serverLine(first)}>{first.server} didn't start</span>
          <button type="button" data-mcp-open-settings={first.server} onClick={openMcpSettings} className={ACTION}>
            Open Settings › MCP
          </button>
        </>
      ) : (
        <>
          <SignInButton server={first} className="-ml-1.5 min-w-0 truncate text-left" />
          <span className="flex-1" />
        </>
      )}
      {more ? (
        <button type="button" onClick={openMcpSettings} className="pressable -my-0.5 h-5 shrink-0 px-1 text-label text-faint hover:text-foreground">
          {more} more
        </button>
      ) : null}
    </div>
  )
}
