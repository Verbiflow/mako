// Prints this app's macOS notification settings as JSON and exits.
//
// Electron exposes no API for UNUserNotificationCenter authorization, and a
// scheduled banner only reports failure after the fact, so the desk cannot
// otherwise say whether you would actually see one. This helper ships inside
// the app bundle next to the Electron executable: NSBundle resolves the bundle
// by walking up from the executable path, and macOS keys notification records
// to the code-signing identifier, which the build embeds as an Info.plist
// section (CFBundleIdentifier = the app's own id).
import Foundation
import UserNotifications

let semaphore = DispatchSemaphore(value: 0)
var authorization = "unknown"
var alert = "unknown"
var alertStyle = "unknown"
UNUserNotificationCenter.current().getNotificationSettings { settings in
  switch settings.authorizationStatus {
  case .authorized: authorization = "authorized"
  case .provisional: authorization = "provisional"
  case .ephemeral: authorization = "ephemeral"
  case .denied: authorization = "denied"
  case .notDetermined: authorization = "not-determined"
  @unknown default: authorization = "unknown"
  }
  switch settings.alertSetting {
  case .enabled: alert = "enabled"
  case .disabled: alert = "disabled"
  case .notSupported: alert = "not-supported"
  @unknown default: alert = "unknown"
  }
  switch settings.alertStyle {
  case .none: alertStyle = "none"
  case .banner: alertStyle = "banner"
  case .alert: alertStyle = "alert"
  @unknown default: alertStyle = "unknown"
  }
  semaphore.signal()
}
if semaphore.wait(timeout: .now() + 3) == .timedOut {
  authorization = "timeout"
}
print("{\"authorization\":\"\(authorization)\",\"alert\":\"\(alert)\",\"alertStyle\":\"\(alertStyle)\"}")
