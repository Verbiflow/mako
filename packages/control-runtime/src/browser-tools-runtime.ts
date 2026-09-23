import { z } from "zod"
import {
  BrowserCommandSchema,
  BrowserFault,
  type BrowserCommand,
} from "./contracts/browser-control.js"
import type { JsonValue } from "./json.js"
import {
  controlArtifactsDirectory,
  ControlProgramRuntime,
  type ControlProgramOutput,
} from "@mako/control/program"

export interface BrowserCall {
  (command: BrowserCommand, signal: AbortSignal): Promise<JsonValue>
  close?(): Promise<void>
}

const imageSchema = z.object({
  data: z.string().max(24 * 1024 * 1024),
  mimeType: z.enum(["image/png", "image/jpeg"]),
  target: z.json(),
  view: z.string(),
  coordinates: z.json().optional(),
  clip: z.json().optional(),
})

/** The action literal one member of the wire contract's union answers to. */
export function actionNameOf(
  schema: (typeof BrowserCommandSchema.options)[number]
): string {
  return z
    .object({ action: z.object({ const: z.string() }) })
    .parse(z.toJSONSchema(schema, { io: "input" }).properties).action.const
}

/** Every browser action, in the order the API reference lists them. */
export const BROWSER_ACTIONS = BrowserCommandSchema.options.map(actionNameOf)

export type BrowserOutput = ControlProgramOutput

/** One bounded script worker per MCP client; approved transport lives in the host. */
export class BrowserToolsRuntime {
  private readonly runtime: ControlProgramRuntime
  private readonly call: BrowserCall

  constructor(call: BrowserCall, taskId = process.env.MAKO_TASK_ID) {
    this.call = call
    this.runtime = new ControlProgramRuntime({
      namespace: "browser",
      actions: BROWSER_ACTIONS,
      artifacts: controlArtifactsDirectory("browser", taskId),
      call: (command, signal) => {
        const parsed = BrowserCommandSchema.safeParse(command)
        if (!parsed.success)
          throw new BrowserFault({
            code: "invalid-request",
            message: `Invalid arguments for browser.${String(command.action)}. ${z.prettifyError(parsed.error).replace(/\s+/g, " ").trim()} Nothing was dispatched; correct the arguments and call again.`,
            outcome: "not-dispatched",
          })
        return call(parsed.data, signal)
      },
      image: (value) => {
        const image = imageSchema.parse(value)
        return [
          {
            type: "text",
            text: JSON.stringify({
              target: image.target,
              view: image.view,
              coordinates: image.coordinates,
              clip: image.clip,
            }),
          },
          {
            type: "image",
            data: image.data,
            mimeType: image.mimeType,
          },
        ]
      },
      fault: (detail) => new BrowserFault(detail),
    })
  }

  run(source: string, signal: AbortSignal): Promise<BrowserOutput[]> {
    return this.runtime.run(source, signal)
  }

  wait(cell: number, signal: AbortSignal): Promise<BrowserOutput[]> {
    return this.runtime.wait(cell, signal)
  }

  async close(): Promise<void> {
    await this.runtime.close()
    await this.call.close?.()
  }
}
