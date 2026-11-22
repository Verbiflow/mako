# Mako on Windows

Mako's host, its desktop app and its installer run on Windows x64. This page
says what works there, how each claim is checked, and what doesn't work yet.
Every check named here runs on GitHub's `windows-latest` (Windows Server 2025,
one 1024×768 display, no GPU), so "checked" means on that machine: nothing here
has been run on a person's Windows 10 or 11 PC by these workflows.

Builds are unsigned until signing is set up (the release workflow signs only a
version tag's build, and only when the repository holds a certificate), so
Windows shows its SmartScreen warning for an installer downloaded today.

## What works, and where it's checked

| | macOS | Linux | Windows x64 | Checked on Windows by |
| --- | --- | --- | --- | --- |
| The host, headless | Yes | Yes | Yes | `host-windows.yml`: `/health`, both clients, a Thread on a stand-in harness run, stopped and closed |
| The host's transport | Unix socket in a private folder | Unix socket | A named pipe drawn for each start, both ends proving a shared secret before any request (`@mako/lazy/private-pipe`) | `test-windows-pipes.ts`: a program holding the name is sent only nonces |
| Harness CLIs found and started | PATH and the harnesses' folders | Same | PATHEXT, npm `.cmd` shims run as Node, other batch files through `cmd.exe`; only from folders no other account can write | `test-windows-launch.ts`, `test-windows-pipes.ts` |
| A harness's whole tree ended | Process group | Process group | A job object per provider (`mako-windows run-in-job`); `taskkill /T` where a pid is held | `prove.mjs`: closing a Thread, and killing the host outright, leave no process |
| Stopping the host | SIGTERM | SIGTERM | `mako-host stop` (Windows has no SIGTERM), Ctrl-Break | `prove.mjs`, the installer smoke |
| Terminals | Login shell | Login shell | PowerShell 7, else Windows PowerShell, else `cmd.exe`, in a ConPTY | `prove.mjs` |
| Sign-in flows that need a terminal | `script` | `script` | A ConPTY bridge | `test-windows-launch.ts` (the bridge, not a real sign-in) |
| Projects by typed path | `/…`, `~/…` | Same | Also `C:\…`, `C:/…`, `~\…`; shares are opened only when asked, device paths never | `test-host-paths.ts` |
| A Thread's app (`thread-processes`) | `ps` | `ps`, `/proc` | One CIM query, kept 1.5 s; ports by `Get-NetTCPConnection` | `prove-thread-app.ts` |
| Local Control (`mako-control`) | Unix socket | Unix socket | `mako-control.cmd`, proven pipes, a relay to the task's worker | `prove.mjs`, the installer smoke |
| Computer use | cua-driver (AX) | cua-driver (AT-SPI, X11) | cua-driver for Windows (UI Automation), shipped beside `Mako.exe`, proving itself to the host | `windows-control.yml`, the installer smoke |
| Browser control | Yes | Yes | Chrome and Edge: discovery, native host, tab video | `windows-browser.yml` |
| Window and display video | ScreenCaptureKit | PipeWire or X11 | Windows Graphics Capture into Media Foundation H.264 (`mako-video.exe`); no FFmpeg | `windows-video.yml`, the installer smoke |
| The desktop app | Yes | Yes | Yes: per-user installer, login item, `mako:` links, updates feed | `windows-release.yml`'s smoke, which also drives the window |
| Arm64 | Apple silicon | x64 and arm64 hosts | Not built by CI | Nothing: GitHub's hosted Windows runners used here are x64 |

## The installed app, end to end

`scripts/smoke-windows-install.mjs` installs the release workflow's installer
on the runner and uses the app as a person and an agent would:

- The window shows, its host answers, and the helpers sit beside `Mako.exe`:
  `mako-windows.exe`, `mako-video.exe`, `cua-driver.exe`.
- A Thread on a stand-in for a harness's CLI (a `grok.cmd` on `PATH`) runs. The
  agent's own `mako-control.cmd` reaches Local Control; through the shipped
  driver, which must prove itself to the host, it observes a fixture window,
  sets its field, clicks its button, records the window to an MP4 with no
  FFmpeg on `PATH`, and takes an Appshot. Closing the Thread ends everything
  the harness started.
- In the window itself, over its DevTools protocol: a Thread's row is clicked
  with the mouse, its reply read on screen, a message typed into the composer
  and sent with the Send button, and that reply read on screen.
- `mako-host stop` ends the host through its own stop, nothing of Mako's is
  left running, and the app launched again reads back the Thread it wrote.
- The app is uninstalled with it running: no process, login item, scheme or
  native-messaging registration is left, and the person's data stays.

## Limits

- **Unsigned builds.** See above. The trust check on programs the host finds,
  and the DLL-planting check on the installer, don't replace a signature.
- **Elevated windows.** The driver runs at the person's integrity level and
  refuses, in words, a window of a program run as administrator (UIPI drops the
  input and reports success). Driving one needs an elevated or uiAccess driver,
  which Mako doesn't ship. See [Local Control on Windows](local-control-windows.md#elevated-windows-uipi).
- **Background keyboard.** Keys addressed to a background window by process
  aren't offered: focusing the element through UI Automation brought the window
  forward in some runs. Background pointer and element actions are offered;
  typing needs the window in front.
- **Menus** (`invoke_menu`) aren't verified, so that route stays unavailable.
- **Held input after a crash** isn't journaled and released, as it is on a Mac.
- **Which Thread changed which file.** The host's record of changes works on
  Windows: it keeps a Windows path as Windows writes it (`C:\Users\ana\site`),
  whichever way a harness, Git or the system wrote it, and a turn's edit is
  attributed to it on a Windows host (`prove.mjs`). Its suites run on
  `windows-latest` (`host-windows.yml`, the `attribution` job). Open there: one
  case of the writer's recovery (a worker that never answers) doesn't finish,
  and one suite's process doesn't end after its cases pass; both are named
  where they are skipped. A folder named by an 8.3 short name
  (`C:\Users\RUNNER~1\…`) and by its full name is two folders to the record. A
  path a shell command names as Git Bash writes it (`/c/Users/…`) isn't read
  as a Windows path. Files changed outside a project aren't followed on
  Windows or Linux (the system's own history of changes is read on a Mac only).
- **More than one display.** The runner has one. Scaling is checked at 125%
  (below); a second display, or displays at different scales, never were.
- **Video posters.** A video's poster frame isn't made on Windows; a player
  draws the video's own first frame.
- **Words written for a Mac.** The window and the host say "this computer"
  on Windows and Linux where a Mac says "this Mac" (`computer-words.ts`). The
  phone and browser client and the shared setup steps still say "Mac": they
  name another computer, whose system the page doesn't know.
- **Hardware video encoding.** The helper takes a hardware H.264 encoder where
  one enumerates and Windows' software encoder otherwise. The runner has no
  GPU: the software path, the fallback from `auto`, and the refusal when a
  hardware encoder is asked for outright are checked; a hardware encoder
  itself has never run in CI.
- **Pausing a Thread's app** while its files move (SIGSTOP elsewhere) is
  skipped on Windows, and a process that left its run's tree can't be told by
  its environment there.
- **What a process has open**, its working folder and its connections are
  unknown on Windows rather than guessed; listening ports are read.
- **A console's close** gives a host a few seconds before Windows ends it. The
  host stops on it as on Ctrl-Break (both are checked, on a host with nothing
  running); a stop that takes longer than Windows allows is cut short.
- **Arm64.** `package-windows.mjs` accepts `--arch=arm64`, and nothing builds or
  runs it in CI.

## Newly checked, and not checked

- **Display scaling.** `scripts/windows-host/display-scale.ps1` raises the
  runner's display one step, as Settings > Display > Scale does (a program that
  isn't DPI-aware then sees 819×614 where it saw 1024×768, which is 125%). The
  driver's 37 checks and computer use from a Thread pass again at that scale
  (`windows-control.yml`, run 44932409151). Higher scales don't fit a 1024×768
  display, and there is one display, so mixed scales and a second monitor are
  not checked.
- **An older driver.** A driver that says `+mako.30` is started without the
  proof, the log says so, and it lists windows and takes an Appshot. It is
  today's driver behind a shim that changes only what `--version` prints, not
  a build of an older release.
- **Encoder choice.** `auto` fell back to Windows' software encoder and
  encoded; `software` encoded; `hardware`, asked for outright, sent nothing
  and said no hardware encoder could start. No hardware encoder has run.
- **Ctrl-Break and a console's close** on a host with a console of its own:
  both ran the host's own stop and it exited (`host-windows.yml`).
- **Not run anywhere:** Windows on Arm, Windows 10 or 11 on a PC, a GPU, a
  second display, a signed build, a real harness CLI signed in.

## Idle cost

The installed app on the runner, measured by the smoke 30 s after its checks
(`idle` in `smoke.json`, run 44933737038), after two Threads had run and been
closed: 10 processes of `Mako.exe`, 926 MB working set, 708 MB private, 0.3%
of one core.

| Process | Working set | Private | Why it is there |
| --- | --- | --- | --- |
| Desktop (Electron main) | 147 MB | 103 MB | The window's process |
| Renderer | 186 MB | 104 MB | The window's page |
| GPU process | 69 MB | 27 MB | Electron's, software rendering on the runner |
| Network utility | 25 MB | 11 MB | Electron's |
| Crash reports | 16 MB | 9 MB | Electron's |
| Host | 183 MB | 196 MB | `Mako.exe` as Node; outlives the window |
| Host: session catalog reader | 92 MB | 79 MB | Reads the harnesses' session files off the host's thread |
| Host: file watcher | 66 MB | 70 MB | Watches open projects |
| Host: Git helper | 61 MB | 34 MB | Runs Git reads off the host's thread |
| Host: Local Control worker | 80 MB | 76 MB | A loaded spare, kept ten quiet minutes after a task used control |
| `cua-driver.exe` | 33 MB | 11 MB | Started at the first use of the computer; stays while the host runs |

Before any Thread has used the computer there is no worker and no driver: 9
processes, about 860 MB (run 44915311620). Electron's five processes are
about 420 MB of that and the host's four about 440 MB. Each of the host's children is `Mako.exe`
started again as Node, so each pays for a runtime (60–90 MB) before it does
anything; that, not their work, is most of the host's share. The watcher and
the Git helper exiting when idle is separate work in progress. The catalog
reader, and Electron's own processes, would remain.
