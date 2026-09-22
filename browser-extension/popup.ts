import { z } from "zod"

const stateSchema = z.object({
  enabled: z.boolean().default(true),
  status: z.string().default("Connecting to Mako…"),
})
const statusElement = document.querySelector("body > [role=status]")
const button = document.querySelector("[data-access]")
let enabled = true
async function render() {
  const state = stateSchema.parse(
    await chrome.storage.local.get(["enabled", "status"])
  )
  enabled = state.enabled
  if (statusElement) statusElement.textContent = state.status
  if (button)
    button.textContent = enabled ? "Pause browser access" : "Connect to Mako"
}
button?.addEventListener("click", () => {
  void chrome.runtime
    .sendMessage({ kind: "set-enabled", enabled: !enabled })
    .then(render)
})
chrome.storage.onChanged.addListener(() => void render())
void render()

const nameInput = document.querySelector<HTMLInputElement>("#profile-name")
void chrome.storage.local
  .get(["profileName", "resolvedProfileName"])
  .then((value) => {
    const names = z
      .object({
        profileName: z.string().optional(),
        resolvedProfileName: z.string().optional(),
      })
      .parse(value)
    if (nameInput)
      nameInput.value = names.profileName ?? names.resolvedProfileName ?? ""
  })
document.querySelector("form")?.addEventListener("submit", (event) => {
  event.preventDefault()
  const profileName = nameInput?.value.trim()
  if (!profileName) return
  void chrome.runtime
    .sendMessage({ kind: "set-profile-name", profileName })
    .then(() => {
      const message = document.querySelector("[data-name-status]")
      if (message)
        message.textContent = "Name saved. Refresh profiles in Mako Settings."
    })
})
