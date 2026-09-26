import {execFile} from "node:child_process"
import {randomUUID} from "node:crypto"
import {readFileSync} from "node:fs"
import {promisify} from "node:util"
import {mkdir, writeFile, readFile} from "node:fs/promises"
import {join} from "node:path"
import {setTimeout as delay} from "node:timers/promises"

export const cocoaFixtureSource = `
import AppKit
final class Handler: NSObject {
  let field: NSTextField
  let output: NSTextField
  init(field: NSTextField, output: NSTextField) { self.field = field; self.output = output }
  @objc func verify(_ sender: Any?) { output.stringValue = field.stringValue }
}
var events: [[String: Any]] = []
var eventsDropped = 0
func note(_ kind: String, source: Int64 = 0) {
  if events.count >= 64 { eventsDropped += 1; return }
  events.append(["kind": kind, "atMs": Date().timeIntervalSince1970 * 1000,
    "foreground": NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0,
    "sourcePid": source])
}
let app = NSApplication.shared
let activationObserver = NotificationCenter.default.addObserver(forName: NSApplication.didBecomeActiveNotification, object: app, queue: .main) { _ in note("active") }
let workspaceObserver = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { notification in
  if let activated = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication,
     activated.processIdentifier == ProcessInfo.processInfo.processIdentifier {
    note("workspaceActivatedFixture")
  }
}
let mouseMonitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown]) { event in
  note("mouseDown", source: event.cgEvent?.getIntegerValueField(.eventSourceUnixProcessID) ?? 0)
  return event
}
app.setActivationPolicy(.accessory)
let window = NSWindow(contentRect: NSRect(x: 240, y: 240, width: 480, height: 200), styleMask: [.titled, .closable], backing: .buffered, defer: false)
window.title = "Mako cocoa fixture"
let field = NSTextField(frame: NSRect(x: 20, y: 130, width: 300, height: 24))
field.setAccessibilityLabel("Proof")
let button = NSButton(title: "Verify proof", target: nil, action: nil)
button.frame = NSRect(x: 330, y: 128, width: 130, height: 28)
let output = NSTextField(labelWithString: "")
output.frame = NSRect(x: 20, y: 70, width: 440, height: 24)
output.setAccessibilityLabel("Result")
let handler = Handler(field: field, output: output)
button.target = handler
button.action = #selector(Handler.verify(_:))
window.contentView?.addSubview(field)
window.contentView?.addSubview(button)
window.contentView?.addSubview(output)
// Make the fixture visible behind existing windows; never cover the user's work.
window.orderBack(nil)
note("windowShown")
let statusPath = CommandLine.arguments[1]
Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { _ in
  let selection = field.currentEditor()?.selectedRange.length ?? 0
  let state: [String: Any] = ["pid": ProcessInfo.processInfo.processIdentifier, "input": field.stringValue, "selection": selection, "value": output.stringValue, "events": events, "eventsDropped": eventsDropped]
  if let data = try? JSONSerialization.data(withJSONObject: state) {
    try? data.write(to: URL(fileURLWithPath: statusPath + ".next"))
    rename(statusPath + ".next", statusPath)
  }
}
app.run()
`

const alive=(pid)=>{ try { process.kill(pid,0); return true } catch { return false } }

/** Native AppKit fixture; Electron input is covered separately through pages.
 * AppKit activates a directly executed app when it finishes launching, before
 * any control call. `open -g` asks LaunchServices not to activate the bundle. */
export async function startCocoaFixture({root,title}) {
  const source=join(root,"native-proof.swift"), bundle=join(root,"Native Proof.app"), status=join(root,"native-proof.json")
  await mkdir(join(bundle,"Contents/MacOS"),{recursive:true})
  await writeFile(join(bundle,"Contents/Info.plist"),`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>native-proof</string>
<key>CFBundleIdentifier</key><string>dev.mako.test.native-proof.${randomUUID()}</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSUIElement</key><true/>
</dict></plist>
`)
  await writeFile(source,cocoaFixtureSource.replace('"Mako cocoa fixture"',JSON.stringify(title)))
  await promisify(execFile)("xcrun",["swiftc","-O","-o",join(bundle,"Contents/MacOS/native-proof"),source],{timeout:180000})
  await promisify(execFile)("open",["-g","-n",bundle,"--args",status],{timeout:30000})
  const state=async()=>JSON.parse(await readFile(status,"utf8"))
  let pid
  async function until(check,what,timeoutMs=15000) {
    const deadline=Date.now()+timeoutMs
    while(Date.now()<deadline) {
      const result=await check().catch(()=>undefined)
      if(result) return result
      if(pid!==undefined&&!alive(pid)) throw Error("Native fixture exited")
      await delay(30)
    }
    throw Error(`Fixture condition timed out: ${what}`)
  }
  const started=async()=>{ const value=await until(state,"native fixture startup"); pid=value.pid; return value }
  const stop=()=>{
    try { pid??=JSON.parse(readFileSync(status,"utf8")).pid } catch {}
    if(pid!==undefined&&alive(pid)) process.kill(pid,"SIGTERM")
  }
  return {state,until,started,stop}
}
