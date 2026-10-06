import { GrokToolMeta, grokToolName as nativeName } from "@mako/sessions/harnesses"
import type { ProviderAcpSource } from "../acp-source.js"

export const grokToolName: NonNullable<ProviderAcpSource["toolName"]> = (tool) => nativeName(GrokToolMeta.safeParse(tool._meta).data, tool.title)
