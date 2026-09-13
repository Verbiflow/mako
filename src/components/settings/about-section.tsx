import { Action } from "@/components/ui/kit"
import { desktop } from "@/state/desktop"
import { useUpdates } from "@/state/updates"
import { ExternalLinkIcon } from "lucide-react"
import { FaGithub } from "react-icons/fa"
import appIcon from "/icons/app-icon.png?url"

const REPOSITORY = "https://github.com/Verbiflow/mako"

export function AboutSection() {
  const version = useUpdates((state) => state.version)
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-3">
        <img
          src={appIcon}
          alt=""
          className="size-14 rounded-xl ring-1 ring-hairline"
        />
        <span className="min-w-0">
          <span className="block text-title font-semibold">Mako</span>
          <span className="block text-ui text-muted-foreground">
            Run coding agents on your Mac.
          </span>
          <span className="mt-0.5 block text-label text-faint">
            Version {version || "development"} · Apple silicon
          </span>
        </span>
      </div>

      <p className="text-ui leading-relaxed text-muted-foreground">
        Mako opens sessions from Claude Code, Codex, Cursor, Grok, Devin, and
        OpenCode 2 and OpenCode. Credentials remain in each provider’s own storage.
      </p>

      <div className="flex items-center gap-2">
        <Action onClick={() => void desktop.openUrl(REPOSITORY)}>
          <FaGithub />
          GitHub
        </Action>
        <Action
          tone="outline"
          onClick={() => void desktop.openUrl(`${REPOSITORY}/issues`)}
        >
          Report an issue
          <ExternalLinkIcon />
        </Action>
      </div>

      <p className="text-label leading-relaxed text-faint">
        Released under the{" "}
        <button
          type="button"
          onClick={() => void desktop.openUrl(`${REPOSITORY}/blob/main/LICENSE`)}
          className="pressable rounded text-muted-foreground underline decoration-foreground/20 underline-offset-2 hover:text-foreground"
        >
          MIT License
        </button>
        . © 2026 Verbiflow. Provider names and marks belong to their respective
        owners.
      </p>
    </div>
  )
}
