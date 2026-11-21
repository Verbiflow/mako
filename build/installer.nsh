; Mako's additions to electron-builder's NSIS installer (scripts/package-windows.mjs).
;
; The app registers itself at runtime: the login item under the Run key and the `mako:` scheme under Software\Classes
; (electron/client-main.ts), and browser control's native-messaging host for each Chromium browser, with its wrapper
; and manifest in ~/.mako/bin. Uninstalling removes them all; an update's uninstall of the version it replaces keeps
; them, since the new version registers the same.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Mako"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "Mako"
    DeleteRegKey HKCU "Software\Classes\mako"
    ; Browser control's native-messaging host, registered for each Chromium browser it found.
    DeleteRegKey HKCU "Software\Google\Chrome\NativeMessagingHosts\dev.mako.browser"
    DeleteRegKey HKCU "Software\Microsoft\Edge\NativeMessagingHosts\dev.mako.browser"
    DeleteRegKey HKCU "Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\dev.mako.browser"
    DeleteRegKey HKCU "Software\Chromium\NativeMessagingHosts\dev.mako.browser"
    DeleteRegKey HKCU "Software\Vivaldi\NativeMessagingHosts\dev.mako.browser"
    DeleteRegKey HKCU "Software\TheBrowserCompany\Arc\NativeMessagingHosts\dev.mako.browser"
    Delete "$PROFILE\.mako\bin\mako-browser-host-*.cmd"
    Delete "$PROFILE\.mako\bin\dev.mako.browser-*.json"
  ${endIf}
!macroend
