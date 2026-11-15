import type { McpSignIn } from "@mako/host/contracts/mcp-sign-ins"
import { harnessLabel } from "@/lib/harness-label"
import { cn } from "@/lib/utils"
import { signInMcp, useMcpSignIns } from "@/state/mcp-sign-ins"

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
      className={cn("pressable -my-0.5 h-5 shrink-0 px-1.5 text-label font-medium text-foreground/80 hover:bg-fill-hover hover:text-foreground disabled:opacity-50", className)}
    >
      {signing ? "Signing in…" : server.state?.kind === "failed" ? "Try again" : `Sign in to ${server.server}`}
    </button>
  )
}

/** Why it's said: the harness that couldn't start it, and how its sign-in goes. */
function serverLine(server: McpSignIn): string {
  if (server.state?.kind === "failed") return `${server.state.reason} ${harnessLabel(server.harness)} still can't reach ${server.server}.`
  return `${harnessLabel(server.harness)} can't use ${server.server} until you sign in${server.way === "page" ? " on its page" : ""}.`
}

/** Settings › MCP: every server that needs sign-in, each with its one way in, gone once it's signed in. */
export function McpSignInsList() {
  const servers = useMcpSignIns((state) => state.servers)
  if (!servers.length) return null
  return (
    <section aria-label="Servers that need sign-in" className="mb-6 flex flex-col gap-2 pt-4">
      {servers.map((server) => (
        <div key={`${server.harness}\0${server.server}`} className="flex items-center gap-3 bg-raised px-2.5 py-2">
          <span className="min-w-0 flex-1 text-label text-muted-foreground">{serverLine(server)}</span>
          <SignInButton server={server} />
        </div>
      ))}
    </section>
  )
}

/**
 * Above the rail's footer while a server needs sign-in: the first one with its button, the rest one press away in
 * Settings › MCP. Said here once, not in every conversation that starts.
 */
export function McpSignInRailLine({ className }: { className?: string }) {
  const servers = useMcpSignIns((state) => state.servers)
  const first = servers[0]
  if (!first) return null
  const more = servers.length - 1
  return (
    // The rail is narrow: the button says what to do, and its title why (`serverLine`).
    <div data-mcp-sign-ins={servers.length} className={cn("flex items-center gap-2 border-t border-hairline px-3 py-2 text-label text-muted-foreground", className)}>
      <SignInButton server={first} className="-ml-1.5 min-w-0 truncate text-left" />
      <span className="flex-1" />
      {more ? (
        <button
          type="button"
          onClick={() => window.dispatchEvent(new CustomEvent("mako:settings", { detail: "mcp" }))}
          className="pressable -my-0.5 h-5 shrink-0 px-1 text-label text-faint hover:text-foreground"
        >
          {more} more
        </button>
      ) : null}
    </div>
  )
}
