import { ControlFault } from "@mako/control/control"
import { CONTROL_HELP_TOPICS as controlHelpTopics } from "./control-session-protocol.js"

interface CommandHelp {
  summary: string
  usage: string
  flags: string[]
  output: string
  notes?: string
  examples: string[]
}
export const controlCommands = new Map<string, CommandHelp>(
  Object.entries({
    status: {
      summary:
        "Read this task's backend availability without requesting permission.",
      usage: "status",
      flags: [],
      output:
        "JSON availability, native/browser configuration and artifact directory.",
      examples: ["mako-control status"],
    },
    browsers: {
      summary:
        "List browser IDs, connection state and saved preference. Does not connect.",
      usage: "browsers",
      flags: [],
      output:
        "JSON browser discovery result; use the exact browser ID for connect/tabs/open. Each browser's next field names the SDK call its state allows or the user action it waits for.",
      examples: ["mako-control browsers | jq ."],
    },
    connect: {
      summary: "Explicitly connect one discovered browser.",
      usage: "connect --browser ID",
      flags: ["browser"],
      output:
        "JSON connection result or a structured refusal. Never substitutes another browser.",
      examples: ["mako-control connect --browser chromium:example"],
    },
    tabs: {
      summary: "List pages in a discovered browser.",
      usage: "tabs --browser ID [--all]",
      flags: ["browser", "all"],
      output:
        "JSON {kind:'pages',browser,pages:[{tab,title,url,claimed}],hidden?}. Pass tab to claim. --all adds workers, frames and other non-page targets with their raw CDP fields.",
      examples: ["mako-control tabs --browser chromium:example | jq '.pages'"],
    },
    open: {
      summary: "Create a task-owned page, optionally navigating to a URL.",
      usage: "open --browser ID [--url URL] [--input FILE|-]",
      flags: ["browser", "url", "input"],
      output:
        "JSON receipt {target,url,title}: the exact page target plus where the tab is after opening. Save the whole receipt; --target-file and control.tab() accept it. url and title are omitted only if that lookup fails. A failed navigation adds navigation with its fault and exits nonzero; inspect the same target before retrying.",
      notes:
        "--input accepts browser open options such as disposition, background, context and lifetime. An explicit flag overrides the same JSON option.",
      examples: [
        "mako-control open --browser chromium:example --url https://example.com > target.json",
      ],
    },
    claim: {
      summary: "Claim an existing exact tab for this task.",
      usage: "claim --browser ID --tab ID",
      flags: ["browser", "tab"],
      output:
        "JSON receipt {target,url,title}. The target includes lease and generation; never edit them. --target-file and control.tab() accept the whole receipt.",
      examples: [
        "mako-control claim --browser chromium:example --tab 42 > target.json",
      ],
    },
    apps: {
      summary: "Discover native applications.",
      usage: "apps [--all]",
      flags: ["all"],
      output:
        "JSON {apps:[{name,pid,bundle_id?,active?}],hidden?} for running apps. --all adds installed apps that are not running, with launch paths. Does not activate an app.",
      examples: ["mako-control apps | jq ."],
    },
    windows: {
      summary: "Discover windows owned by an exact native process.",
      usage: "windows --pid PID",
      flags: ["pid"],
      output:
        "JSON window list. Use an observed pid/window_id pair for native targets.",
      examples: ["mako-control windows --pid 1234 | jq ."],
    },
    observe: {
      summary:
        "Read an exact page/window, optionally scoped to a form or subtree. No screenshot.",
      usage: "observe --target-file FILE|- [--input FILE|-]",
      flags: ["target-file", "input"],
      output:
        "JSON observation with nodes, refs, coverage and exact-value evidence. Incomplete coverage cannot prove absence or uniqueness.",
      notes:
        'Native target file: {"kind":"window","pid":1234,"window_id":56}. Obtain both IDs through discovery. Use api --topic observations for scope options. Reobserve after mutation; stale refs are refused.',
      examples: [
        "mako-control observe --target-file target.json > view.json",
        "cat target.json | mako-control observe --target-file -",
      ],
    },
    act: {
      summary:
        "Dispatch one operation to an exact element, found by role and name or by ref.",
      usage:
        "act --target-file FILE|- --input FILE|- [--role ROLE --name NAME]",
      flags: ["target-file", "input", "role", "name"],
      output:
        "JSON dispatch receipt. Success is not proof the intended UI state was reached; verify with expect.",
      notes:
        'With a selector, the element is read fresh and must match exactly once; nothing is dispatched otherwise. Pass it as --role/--name or as selector:{role,name,within?} in the input, using the role and exact name an observation lists (names can differ from visible labels). Selector kinds: set-text {text}, activate, press-key {key,modifiers?}, select-option {value}|{label}. Without a selector, the input is a ref operation from the latest observation: set-text, activate, press-key, pointer, scroll, select-option, command; pointer coordinates need the screenshot view token. Never replay an uncertain action.',
      examples: [
        `printf '%s' '{"kind":"set-text","text":"Ada","selector":{"role":"textbox","name":"Name","within":[{"role":"form","name":"Shipping"}]}}' | mako-control act --target-file target.json --input -`,
        `printf '%s' '{"kind":"activate"}' | mako-control act --target-file target.json --role button --name 'Create image' --input -`,
        'printf \'%s\' \'{"kind":"set-text","ref":"REF_FROM_OBSERVATION","text":"Ada"}\' | mako-control act --target-file target.json --input -',
      ],
    },
    expect: {
      summary:
        "Wait until an exact element shows the expected value, states or absence.",
      usage:
        "expect --target-file FILE|- --input FILE|- [--role ROLE --name NAME]",
      flags: ["target-file", "input", "role", "name"],
      output:
        "JSON {status:'matched',evidence,coverage}. If the expectation is not met before timeoutMs (default 5000), it exits 5 with code assertion-failed and the last observation. Never dispatches input.",
      notes:
        "Input: {role,name,within?,value?,states?,absent?,timeoutMs?,everyMs?}; --role/--name set role and name. Value equality is exact. absent:true needs complete coverage.",
      examples: [
        `printf '%s' '{"role":"textbox","name":"Name","within":[{"role":"form","name":"Shipping"}],"value":"Ada"}' | mako-control expect --target-file target.json --input -`,
      ],
    },
    close: {
      summary: "Close a task-owned browser tab.",
      usage: "close --target-file FILE|-",
      flags: ["target-file"],
      output:
        "JSON close result. The target is invalid afterwards; later commands on it exit 3 with target-closed.",
      examples: ["mako-control close --target-file target.json"],
    },
    shot: {
      summary:
        "Save an explicit screenshot to a file, optionally selecting one exact element.",
      usage:
        "shot --target-file FILE|- --output PATH [--format png|jpeg] [--role ROLE --name NAME] [--max-side N] [--input FILE|-] [--overwrite]",
      flags: [
        "target-file",
        "input",
        "output",
        "format",
        "overwrite",
        "role",
        "name",
        "max-side",
      ],
      output:
        "JSON path, SHA-256, bytes, dimensions and coordinate metadata. Image bytes never go to stdout.",
      notes:
        "--format selects bytes; the filename does not. Existing output requires --overwrite. Both role and name are required for a selector; duplicate matches refuse. --input accepts {selector:{role,name,within},options:{...}}. Native element screenshots are unsupported; full-window screenshots remain available.",
      examples: [
        "mako-control shot --target-file target.json --format png --output 'screen shot.png'",
        "mako-control shot --target-file target.json --role button --name Save --output save.png --format png",
        `printf '%s' '{"options":{"region":{"x":0,"y":0,"width":600,"height":400}}}' | mako-control shot --target-file target.json --input - --output top.png --format png`,
      ],
    },
    "record start": {
      summary: "Start a session-owned recording of an exact page/window.",
      usage:
        "record start --target-file FILE|- [--directory DIR] [--name NAME] [--fps N] [--max-side N] [--input FILE|-]",
      flags: ["target-file", "input", "directory", "fps", "max-side", "name"],
      output:
        "JSON recording receipt with id and target. Save it to stop/status later; command exit does not stop recording. Its timeline is timeline.jsonl, a journal appended during capture; the finished receipt names timeline.json instead.",
      notes:
        "--input accepts {options:{cursor,maxDurationMs,...}}. Rates depend on the backend; unsupported requests refuse. Requested/output fps does not establish distinct source fps. The receipt’s frames field counts source frames or retained samples, not encoded constant-rate frames; the encoder may duplicate frames.",
      examples: [
        "mako-control record start --target-file target.json --directory ./recordings > recording.json",
      ],
    },
    "record stop": {
      summary: "Stop the exact recording and optionally wait for finalization.",
      usage: "record stop --input RECEIPT|- [--wait]",
      flags: ["target-file", "input", "wait"],
      output:
        "JSON recording receipt. --wait succeeds only with finished output; interruptions exit nonzero and retain any available artifact.",
      notes:
        "Cancellation of this waiter does not replay stop or discard the session-owned finalization. Query status with the same receipt. A finished receipt's timeline is timeline.json, the complete timeline; the timeline.jsonl beside it is the raw journal written during capture.",
      examples: [
        "mako-control record stop --input recording.json --wait > finished.json",
      ],
    },
    "record status": {
      summary: "Read progress or the retained result of an exact recording.",
      usage: "record status --input RECEIPT|-",
      flags: ["target-file", "input"],
      output:
        "JSON recording state, dimensions, timing and artifact paths when available.",
      examples: ["mako-control record status --input recording.json | jq ."],
    },
    exec: {
      summary:
        "Run trusted async JavaScript against the shared browser/computer API.",
      usage: "exec --source-file FILE|-",
      flags: ["source-file"],
      output:
        "JSON array of result/log/artifact blocks. Explicit images and large values are saved to files. Waits for completion; no tickets to collect.",
      notes:
        "control, state, console.log, emitImage and artifacts are available. Await actions; return only needed results. state survives separate invocations. Timeout/cancellation resets the script worker; normal script errors retain state. Read api once for the complete reference, or api --topic examples for recipes. To use an existing CLI target, pass the complete open/claim JSON to control.tab(TARGET_JSON) and store it in state.tab; native targets use control.window({pid,window_id}). Scripts are trusted local code, not a sandbox.",
      examples: [
        "printf '%s' 'return await control.browsers()' | mako-control exec --source-file -",
        "mako-control exec --source-file workflow.js > results.json",
        `jq -r '"state.tab=control.tab(" + tojson + "); return await state.tab.observe();"' target.json | mako-control exec --source-file -`,
      ],
    },
    api: {
      summary: "Read focused JavaScript API help and verified backend schemas.",
      usage:
        "api [--topic TOPIC | --tool NATIVE_ACTION | --domain CDP_DOMAIN [--method METHOD]] [--input FILE|-]",
      flags: ["input", "topic", "tool", "domain", "method"],
      output:
        "JSON signatures, return contracts and examples. Without a topic, returns the complete control reference.",
      notes: `Topics: ${controlHelpTopics.join(", ")}. Native --tool help may connect the driver; ordinary command --help never needs a session.`,
      examples: [
        "mako-control api --topic examples",
        "mako-control api --domain Page --method navigate",
      ],
    },
    diagnostics: {
      summary:
        "Read bounded command/request timings and outcomes for this task.",
      usage: "diagnostics",
      flags: [],
      output:
        "JSON diagnostic metadata. No page contents, source text, arguments or image bytes.",
      examples: ["mako-control diagnostics > diagnostics.json"],
    },
    "session start": {
      summary: "Start an isolated Linux job from trusted configuration.",
      usage: "session start --config FILE",
      flags: ["config"],
      output:
        "JSON sessionFile and descriptor. Mako desktop tasks are attached automatically; do not start a cloud session for them.",
      examples: ["mako-control session start --config job.json > session.json"],
    },
    "session stop": {
      summary: "End the attached session and clean up owned resources.",
      usage: "session stop",
      flags: [],
      output:
        "JSON stopped receipt after session cleanup. Old target/session handles remain invalid.",
      examples: [
        "mako-control session stop --session-file /private/job/session.json",
      ],
    },
  } satisfies Record<string, CommandHelp>)
)

const contract =
  "Task sessions are attached automatically. Override with --session-file FILE only for an exact existing session.\nCommands return JSON on stdout; errors are JSON on stderr. --input, --target-file and --source-file accept - for stdin; only one input may consume it.\nExit codes: 0 completed dispatch/result, 2 invalid request, 3 unavailable/stale session or target, 4 unknown outcome, 5 refused, unmet expectation or failed artifact, 130 cancelled. Never automatically retry an unknown outcome."

export function controlCommandHelp(
  path: readonly string[],
  json = false
): string {
  const key = path.join(" ")
  const selected = controlCommands.get(key)
  if (key && !selected && key !== "record" && key !== "session")
    throw new ControlFault(
      "invalid-request",
      `Unknown command ${JSON.stringify(key)}. Run mako-control --help.`,
      "not-dispatched"
    )
  if (selected)
    return json
      ? JSON.stringify({ command: key, ...selected, contract }) + "\n"
      : `${selected.summary}\n\nUsage: mako-control ${selected.usage}\n\nOutput: ${selected.output}\n${selected.notes ? `\n${selected.notes}\n` : ""}\nExamples:\n${selected.examples.map((example) => `  ${example}`).join("\n")}\n\n${contract}\n`
  const commands = [...controlCommands].filter(
    ([name]) => !key || name.startsWith(`${key} `)
  )
  if (json)
    return (
      JSON.stringify({ commands: Object.fromEntries(commands), contract }) +
      "\n"
    )
  return `mako-control — browser and computer use for one persistent task\n\n${commands.map(([name, entry]) => `  ${name.padEnd(15)} ${entry.summary}`).join("\n")}\n\nRun mako-control COMMAND --help for flags, output and examples. Add --json for structured help.\nBrowser workflow: browsers → connect --browser ID (only if that browser's next field asks for it) → open --browser ID --url URL > target.json → observe --target-file target.json → act / expect by role and name → close.\nNative workflow: apps → windows --pid PID → exec with control.window({pid,window_id}).\nFor a multi-step job, read mako-control api once: it includes handles, selectors, dialogs, verification and recording. api --topic TOPIC returns one section: ${controlHelpTopics.join(", ")}.\n\n${contract}\n`
}
