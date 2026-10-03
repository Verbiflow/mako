import { Action, ListCard, SettingRow, Toggle } from "@/components/ui/kit"
import { togglePref, usePrefs } from "@/state/prefs"
import { projectName, useWorkspaceMoves, workspaceMoves } from "@/state/workspace-moves"
import { ThreadTitleSetting } from "./thread-title-setting"

export function ConversationSection() {
  const showThinking = usePrefs((prefs) => prefs.showThinking)
  const autoDiff = usePrefs((prefs) => prefs.autoOpenDiff)
  const steerOnEnter = usePrefs((prefs) => prefs.steerOnEnter)
  const inWorktree = usePrefs((prefs) => prefs.newThreadsInWorktree)
  const alwaysAllowed = useWorkspaceMoves((moves) => moves.alwaysAllowed)

  return (
    <ListCard>
      <SettingRow
        title="Start new threads on their own branch"
        description="Each new Thread in a Git project gets a worktree: its own checkout and branch, with your .env files. Off makes changes in the project folder. The composer can change this per thread"
      >
        <Toggle
          label="Start new threads on their own branch"
          on={inWorktree}
          onChange={() => togglePref("newThreadsInWorktree")}
        />
      </SettingRow>
      {alwaysAllowed.map((project) => (
        <SettingRow
          key={project}
          title={`Agents in ${projectName(project)} move to their own branch without asking`}
          description={`You chose Always allow for ${project}. Ask again to answer each agent that wants to move.`}
        >
          <Action onClick={() => void workspaceMoves.forget(project)}>Ask again</Action>
        </SettingRow>
      ))}
      <ThreadTitleSetting />
      <SettingRow
        title="Enter steers a running turn"
        description="Off makes Enter queue behind the turn; Cmd+Enter always does the other. Agents that cannot take a message mid-turn queue either way"
      >
        <Toggle
          label="Enter steers a running turn"
          on={steerOnEnter}
          onChange={() => togglePref("steerOnEnter")}
        />
      </SettingRow>
      <SettingRow
        title="Show reasoning"
        description="Collapsed by default; this hides it entirely"
      >
        <Toggle
          label="Show reasoning"
          on={showThinking}
          onChange={() => togglePref("showThinking")}
        />
      </SettingRow>
      <SettingRow
        title="Open the diff on select"
        description="Off keeps the changes panel as a plain list"
      >
        <Toggle
          label="Open the diff on select"
          on={autoDiff}
          onChange={() => togglePref("autoOpenDiff")}
        />
      </SettingRow>
    </ListCard>
  )
}
