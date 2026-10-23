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
import Foundation
import IOKit
import IOKit.pwr_mgt

setvbuf(stdout, nil, _IOLBF, 0)

let arguments = CommandLine.arguments
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
