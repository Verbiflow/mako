// Tells Mako's host when this Mac is about to sleep, and holds the sleep briefly while the host hands running
// agents to the cloud.
//
// macOS sends a process registered for system power notifications `kIOMessageSystemWillSleep` before it sleeps (a
// closed lid, the Apple menu, an idle timer) and waits for `IOAllowPowerChange` before going on, at most 30 seconds.
// Electron reports the sleep only once it's decided, with no way to answer it, so this helper is the one part of Mako
// that can hold it. It speaks lines over its standard streams:
//
//   out  `ready`                      registered
//   out  `will-sleep <id>`            the Mac is about to sleep; it waits for the host's answer
//   in   `allow <id>`                 the host is done: sleep may go on
//   out  `slept <id> <answer|timeout>` how the wait ended (`timeout` after `--hold <seconds>`, 25 by default)
//   out  `can-sleep <id>`             an idle sleep is asked: it's always allowed at once, never held
//   out  `woke`                       the Mac woke
//
// It exits when its standard input closes, so it never outlives the host that started it.
//
// Started with `--keep-awake`, it instead keeps this Mac awake while the host's agents work, with a power assertion
// named for them (what `pmset -g assertions` lists), and says where the Mac's power comes from:
//
//   out  `ready`                      started
//   out  `power ac` | `power battery <percent>`   at start, and each time the power source or charge changes
//   in   `hold idle <name>`           prevent idle sleep (`PreventUserIdleSystemSleep`); a closed lid still sleeps
//   in   `hold lid <name>`            ask for sleep held off with the lid closed too (`PreventSystemSleep`, what `caffeinate -s`
//                                     takes: on power only, and IOKit no longer documents it)
//   out  `holding <idle|lid>`         held, or renamed if it already was
//   in   `release`                    let the Mac sleep again
//   out  `released`
//   out  `failed <code>`              macOS refused the assertion
//
// An assertion lives no longer than the process that made it, so closing standard input releases it too.
import Foundation
import IOKit
import IOKit.ps
import IOKit.pwr_mgt

setvbuf(stdout, nil, _IOLBF, 0)

let arguments = CommandLine.arguments

/** Calls `line` with each line the host writes, on the main run loop, and `closed` once it stops writing. */
func readHost(_ line: @escaping (String) -> Void, closed: @escaping () -> Void) {
  FileHandle.standardInput.readabilityHandler = { handle in
    let data = handle.availableData
    if data.isEmpty {
      handle.readabilityHandler = nil
      DispatchQueue.main.async(execute: closed)
      return
    }
    let lines = String(decoding: data, as: UTF8.self).split(whereSeparator: \.isNewline).map(String.init)
    DispatchQueue.main.async {
      for each in lines { line(each) }
    }
  }
}

/** Where this Mac's power comes from: `power ac`, or `power battery <percent>` (-1 when the charge can't be read). */
func powerLine() -> String {
  guard let info = IOPSCopyPowerSourcesInfo()?.takeRetainedValue() else { return "power ac" }
  let providing = IOPSGetProvidingPowerSourceType(info)?.takeUnretainedValue() as String?
  guard providing == kIOPSBatteryPowerValue else { return "power ac" }
  let sources = (IOPSCopyPowerSourcesList(info)?.takeRetainedValue() as? [CFTypeRef]) ?? []
  for source in sources {
    guard let description = IOPSGetPowerSourceDescription(info, source)?.takeUnretainedValue() as? [String: Any],
      description[kIOPSTypeKey] as? String == kIOPSInternalBatteryType,
      let current = description[kIOPSCurrentCapacityKey] as? Int,
      let capacity = description[kIOPSMaxCapacityKey] as? Int, capacity > 0
    else { continue }
    return "power battery \(current * 100 / capacity)"
  }
  return "power battery -1"
}

var assertion: IOPMAssertionID = 0
/** What's held now: `idle`, `lid`, or nothing. */
var holding: String?
var lastPower = ""

func releaseAssertion() {
  guard holding != nil else { return }
  IOPMAssertionRelease(assertion)
  holding = nil
}

func holdAssertion(_ kind: String, _ name: String) {
  if holding == kind {
    IOPMAssertionSetProperty(assertion, kIOPMAssertionNameKey as CFString, name as CFString)
    print("holding \(kind)")
    return
  }
  releaseAssertion()
  let type = kind == "lid" ? kIOPMAssertionTypePreventSystemSleep : kIOPMAssertionTypePreventUserIdleSystemSleep
  let result = IOPMAssertionCreateWithName(type as CFString, IOPMAssertionLevel(kIOPMAssertionLevelOn), name as CFString, &assertion)
  guard result == kIOReturnSuccess else {
    print("failed \(result)")
    return
  }
  holding = kind
  print("holding \(kind)")
}

func sayPowerIfChanged() {
  let line = powerLine()
  if line == lastPower { return }
  lastPower = line
  print(line)
}

func keepAwake() -> Never {
  print("ready")
  sayPowerIfChanged()
  if let source = IOPSNotificationCreateRunLoopSource({ _ in sayPowerIfChanged() }, nil)?.takeRetainedValue() {
    CFRunLoopAddSource(CFRunLoopGetMain(), source, .defaultMode)
  }
  readHost({ line in
    let words = line.split(separator: " ", maxSplits: 2).map(String.init)
    if words.count == 3, words[0] == "hold", words[1] == "idle" || words[1] == "lid" {
      holdAssertion(words[1], words[2])
    } else if words.first == "release" {
      releaseAssertion()
      print("released")
    }
  }, closed: {
    releaseAssertion()
    exit(0)
  })
  CFRunLoopRun()
  exit(0)
}

if arguments.contains("--keep-awake") { keepAwake() }
let hold: TimeInterval = {
  if let at = arguments.firstIndex(of: "--hold"), at + 1 < arguments.count, let seconds = Double(arguments[at + 1]) {
    return min(max(seconds, 1), 28)
  }
  return 25
}()

// IOMessage.h's `iokit_common_msg(x)` is `sys_iokit | sub_iokit_common | x`, macros Swift can't import.
let canSystemSleep: UInt32 = 0xE000_0270
let systemWillSleep: UInt32 = 0xE000_0280
let systemHasPoweredOn: UInt32 = 0xE000_0300

var rootPort: io_connect_t = 0
var notifier: io_object_t = 0
var notifyPort: IONotificationPortRef?
/** Sleeps waiting for the host's answer, by the notification id macOS gave each. */
var waiting: [Int: Timer] = [:]

func say(_ line: String) {
  print(line)
}

/** Lets one held sleep go on, once, however its wait ended. */
func allow(_ id: Int, _ how: String) {
  guard let timer = waiting.removeValue(forKey: id) else { return }
  timer.invalidate()
  IOAllowPowerChange(rootPort, id)
  say("slept \(id) \(how)")
}

let callback: IOServiceInterestCallback = { _, _, messageType, argument in
  let id = Int(bitPattern: argument)
  switch messageType {
  case canSystemSleep:
    // An idle sleep only asks; Mako never vetoes one.
    IOAllowPowerChange(rootPort, id)
    say("can-sleep \(id)")
  case systemWillSleep:
    waiting[id] = Timer.scheduledTimer(withTimeInterval: hold, repeats: false) { _ in allow(id, "timeout") }
    say("will-sleep \(id)")
  case systemHasPoweredOn:
    say("woke")
  default:
    break
  }
}

rootPort = IORegisterForSystemPower(nil, &notifyPort, callback, &notifier)
guard rootPort != 0, let port = notifyPort else {
  FileHandle.standardError.write("IORegisterForSystemPower failed\n".data(using: .utf8)!)
  exit(1)
}
CFRunLoopAddSource(CFRunLoopGetMain(), IONotificationPortGetRunLoopSource(port).takeUnretainedValue(), .defaultMode)

// The host's answers, read off the main run loop and acted on it.
let input = FileHandle.standardInput
input.readabilityHandler = { handle in
  let data = handle.availableData
  if data.isEmpty {
    // The host is gone: let anything held go on, then leave.
    DispatchQueue.main.async {
      for id in Array(waiting.keys) { allow(id, "host-gone") }
      exit(0)
    }
    return
  }
  let lines = String(decoding: data, as: UTF8.self).split(whereSeparator: \.isNewline)
  DispatchQueue.main.async {
    for line in lines {
      let words = line.split(separator: " ")
      if words.count == 2, words[0] == "allow", let id = Int(words[1]) { allow(id, "answer") }
    }
  }
}

say("ready")
CFRunLoopRun()
