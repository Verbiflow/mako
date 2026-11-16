import { useContext } from "react"
import type { ToolSteps } from "@mako/host/contracts/tool-steps"
import type { ToolCall } from "@/extend/slots"
import { useToolSteps } from "@/state/tool-steps"
import { TurnRunningContext, useTranscriptSource } from "./source-context"

/**
 * A running `mako-computer` `js` call's steps so far, as its host sends them; nothing for any other call, or once it
 * answered. Its conversation's control session runs one program at a time, so the steps are its running call's.
 */
export function useRunningSteps(call: ToolCall): ToolSteps | undefined {
  const { liveId } = useTranscriptSource()
  const turnRunning = useContext(TurnRunningContext)
  const ours = Boolean(liveId) && call.pending && turnRunning && call.tool.kind === "computer" && call.tool.tool === "js"
  const steps = useToolSteps((state) => (ours && liveId ? state.running[liveId] : undefined))
  return steps?.total ? steps : undefined
}
