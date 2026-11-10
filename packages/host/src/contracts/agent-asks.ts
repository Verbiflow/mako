import { z } from "zod"

/** The settings an agent may change for the person, each with its value. `commit-model`: the model that drafts commit messages (Settings › Utility models). */
export const SettingSchema = z.discriminatedUnion("name", [
  z.object({ name: z.literal("hand-off-on-sleep"), value: z.boolean() }),
  z.object({ name: z.literal("continue-after-restart"), value: z.boolean() }),
  z.object({ name: z.literal("harness-order"), value: z.array(z.string().min(1).max(40)).min(1).max(16) }),
  z.object({ name: z.literal("commit-model"), value: z.string().min(1).max(400) }),
  /** Settings › Conversation: keep this Mac awake while agents work, and with its lid closed on power. */
  z.object({ name: z.literal("keep-awake"), value: z.boolean() }),
  z.object({ name: z.literal("keep-awake-lid-closed"), value: z.boolean() }),
])
export type Setting = z.infer<typeof SettingSchema>

/** A setting from a tool's arguments; undefined when the name or its value isn't one. */
export function settingValue(name: string, value: boolean | string | string[] | undefined): Setting | undefined {
  return SettingSchema.safeParse({ name, value }).data
}

/**
 * What an agent below full access asks the person to let it do through Mako's tools, kept in its conversation's control
 * (`ConversationControl.asks`), so a restart keeps it and the desk, the web app and the phone read one fact. The person
 * answers on any of them (`mako:agent-ask-answer`, on the conversation's owner).
 */
export const AgentAskWantSchema = z.discriminatedUnion("kind", [
  /** Move to the cloud. `handsOff`: its Thread works in its own worktree; otherwise it goes onto its own branch first, once its turns end. */
  z.object({ kind: z.literal("move"), move: z.string(), handsOff: z.boolean() }),
  /** Bring it back to this Mac, from inside a cloud Thread: its machine can't reach its Mac, so the person's allow presses it. */
  z.object({ kind: z.literal("back") }),
  /** Rename, Archive and Restore on the Thread's menu. `op`: the operation the answer runs under. */
  z.object({ kind: z.literal("rename"), op: z.string(), title: z.string() }),
  z.object({ kind: z.literal("archive"), op: z.string() }),
  z.object({ kind: z.literal("restore"), op: z.string() }),
  /** A change in Settings. */
  z.object({ kind: z.literal("setting"), setting: SettingSchema }),
  /** Install or Update in Settings › Harnesses: software on the person's machine. */
  z.object({ kind: z.literal("harness"), action: z.enum(["install", "update"]), harness: z.string() }),
  /** Run now, or the switch, on an automation. */
  z.object({ kind: z.literal("automation"), action: z.enum(["run", "on", "off"]), id: z.string(), cwd: z.string().min(1).optional() }),
])
export type AgentAskWant = z.infer<typeof AgentAskWantSchema>

export const AgentAskSchema = z.object({ id: z.string(), at: z.number(), want: AgentAskWantSchema })
export type AgentAsk = z.infer<typeof AgentAskSchema>

/** Only a fresh accepted choice can begin a client action; joined and missing answers confer no new permission. */
export const AgentAskAnswerSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.enum(["answered", "joined"]), ask: z.string(), allow: z.boolean(), want: AgentAskWantSchema }),
  z.object({ outcome: z.enum(["missing", "unavailable"]), ask: z.string() }),
])
export type AgentAskAnswer = z.infer<typeof AgentAskAnswerSchema>

/** An ask's two answers as an approval's options, on the path a Fin's asks take to its Apex and the person. */
export const AGENT_ASK_ALLOW = "allow"
export const AGENT_ASK_KEEP = "keep"

/** What a row says while the ask waits, in a line. */
export function agentAskLine(want: AgentAskWant): string {
  switch (want.kind) {
    case "move":
      return "Wants to move this Thread to the cloud"
    case "back":
      return "Wants to bring this Thread back to your Mac"
    case "rename":
      return `Wants to rename this Thread to ${want.title}`
    case "archive":
      return "Wants to archive this Thread"
    case "restore":
      return "Wants to restore this Thread"
    case "setting":
      return settingLine(want.setting)
    case "harness":
      return `Wants to ${want.action} ${want.harness}`
    case "automation":
      return want.action === "run" ? `Wants to run the automation ${want.id}` : `Wants to turn ${want.action} the automation ${want.id}`
  }
}

function settingLine(setting: Setting): string {
  switch (setting.name) {
    case "hand-off-on-sleep":
      return `Wants to turn ${setting.value ? "on" : "off"} handing agents off when this Mac sleeps`
    case "continue-after-restart":
      return `Wants to turn ${setting.value ? "on" : "off"} continuing turns a restart cut short`
    case "harness-order":
      return `Wants to put ${setting.value[0]} first in your harness order`
    case "commit-model":
      return `Wants to draft commit messages with ${setting.value}`
    case "keep-awake":
      return `Wants to turn ${setting.value ? "on" : "off"} keeping this Mac awake while agents work`
    case "keep-awake-lid-closed":
      return `Wants to turn ${setting.value ? "on" : "off"} keeping this Mac awake with its lid closed`
  }
}

/** How every surface says an ask: `name` is the harness's, as the person reads it. */
export interface AgentAskWords {
  title: string
  description: string
  detail: string
  allow: string
  keep: string
}

export function agentAskWords(want: AgentAskWant, name: string): AgentAskWords {
  const title = `${name} ${agentAskLine(want).replace(/^W/, "w")}`
  switch (want.kind) {
    case "move":
      return {
        title,
        description: want.handsOff ? "with its worktree, branch and sessions" : "onto its own branch first, then the cloud",
        detail: want.handsOff
          ? "Its worktree, branch and every session go to a cloud machine. A turn still running pauses here and goes on there."
          : "Only its own changes leave the project folder for a new branch, once this turn ends; then it moves to a cloud machine.",
        allow: "Move to the cloud",
        keep: "Keep here",
      }
    case "back":
      return { title, description: "with its worktree, branch and sessions", detail: "Its work comes back to the Mac it came from, and the cloud machine ends.", allow: "Bring it back", keep: "Keep in the cloud" }
    case "rename":
      return { title, description: "its title in the list", detail: "The title it shows everywhere; the agent's work goes on as it is.", allow: "Rename", keep: "Keep this title" }
    case "archive":
      return { title, description: "out of the list", detail: "It leaves the list, and a turn still running stops. Restore brings it back.", allow: "Archive", keep: "Keep it" }
    case "setting":
      return { title, description: "in Settings", detail: "It changes this setting for every Thread on this Mac. You can change it back in Settings.", allow: "Change it", keep: "Leave it" }
    case "automation":
      return {
        title,
        description: "in Automations",
        detail: want.action === "run" ? "It starts the automation's agent now, as Run now does." : "It changes whether this automation runs by itself.",
        allow: want.action === "run" ? "Run now" : want.action === "on" ? "Turn on" : "Turn off",
        keep: "Not now",
      }
    case "harness":
      return {
        title,
        description: "on this Mac",
        detail: want.action === "install" ? "It installs this harness on this Mac, as Settings does." : "It updates this harness on this Mac, as Settings does. Sessions running on it keep their version until they restart.",
        allow: want.action === "install" ? "Install" : "Update",
        keep: "Not now",
      }
    case "restore":
      return { title, description: "back in the list", detail: "It comes back to the list as it was.", allow: "Restore", keep: "Leave it archived" }
  }
}
