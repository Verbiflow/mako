import { EyeIcon, HourglassIcon, WorkflowIcon } from "lucide-react"
import type { NativeWork } from "@mako/host/contracts/native-agents"
import { ToolGlyph } from "@/components/transcript/tool-views"
import { HarnessIcon } from "@/components/ui/provider-icon"

/**
 * The kind's glyph, the one the transcript's tool rows and event lines use
 * for it. An agent's is the mark of the harness that runs it (`provider`),
 * as its row in the transcript shows it; the agent glyph only when none is known.
 */
export function WorkGlyph({ work, provider, className }: { work: NativeWork | undefined; provider?: string; className?: string }) {
  switch (work ?? "agent") {
    case "command":
      return <ToolGlyph kind="shell" className={className} />
    case "monitor":
      return <EyeIcon className={className} />
    case "workflow":
      return <WorkflowIcon className={className} />
    case "task":
      return <HourglassIcon className={className} />
    case "agent":
      return provider ? <HarnessIcon harness={provider} className={className} /> : <ToolGlyph kind="agent" className={className} />
  }
}
