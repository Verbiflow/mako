# Isolated Linux acceptance

Each run gets its own X server and D-Bus session. It cannot send desktop input to
the Mac host or to another container. The fixture compares Mako's observations
with GTK's own state file and sends tagged keyboard input to another window.

Build the repository's control package and Electron host first, then:

```sh
docker build -t mako-control-linux:platform-v2 -f scripts/linux-control/Dockerfile .
node scripts/package-control-driver-linux.mjs /absolute/path/to/patched-cua --arch=arm64
```

The packager requires the exact commit and patch in `vendor/cua-driver/release.json`.
It writes a release executable, MIT license and provenance under
`release/control-driver/<version>/linux-<arch>`. The requested architecture is
mandatory and checked against the build image; each architecture has a separate
Cargo target volume. Use `--arch=x64 --image=<x64-image>` for an x64 build. It does not
install or change the running Mac driver. Linux x64 requires its own build and
acceptance; ARM64 results do not establish x64 coverage.

Run the suite with an empty evidence directory:

```sh
docker run --rm \
  --mount type=bind,source="$PWD",target=/repo,readonly \
  --mount type=bind,source=/absolute/path/to/evidence,target=/evidence \
  --mount type=volume,source=mako-control-linux-target,target=/target,readonly \
  -e MAKO_TEST_DRIVER=/target/release/cua-driver \
  mako-control-linux:platform-v2 sh /repo/scripts/linux-control/start-desktop.sh
```

The suite covers exact values, full and capped reads, public strict locators,
30 save jobs, concurrent tagged typing, foreground refusal at both boundaries,
reordered and destroyed controls, modal parent refusal, and a value longer than
the read cap. It intentionally starts an unrestricted driver only inside this
private test desktop. Production hosts keep their authorization boundary.

The runtime requires an accessibility bus and an X11 desktop. On Wayland the
host refuses foreground delivery until the backend can attest the exact focused
window. Do not derive shared-desktop promises from isolated X11 results.

## GNOME Wayland

`Dockerfile.gnome` supplies GNOME 46, AT-SPI, GTK, fonts and FFmpeg in a private
headless session. Build it with `docker build -t mako-control-linux:gnome -f
scripts/linux-control/Dockerfile.gnome .`. Then run the compiled host and the
packaged driver/helper together:

```sh
docker run --name mako-gnome-acceptance --user root \
  -v "$PWD:/repo:ro" \
  -v "$PWD/release/control-driver/0.28.2+mako.12/linux-arm64:/driver:ro" \
  -v "$PWD/release/control-driver/0.28.2+mako.12/linux-arm64/wayland-helper/winrects@cua:/helper:ro" \
  mako-control-linux:gnome sh -c 'rmdir /run/systemd/seats; dbus-daemon --system --fork; exec runuser -u ubuntu -- sh /repo/scripts/linux-control/start-gnome.sh'
docker cp mako-gnome-acceptance:/tmp/gnome-evidence.json ./gnome-evidence.json
```

The empty `/run/systemd/seats` directory is removed only inside this container to
select GNOME's supported dummy login manager; this fixture has no systemd/logind.
The helper is installed only into the container user's temporary desktop.

The probe checks exact Unicode values, covered-window screenshot colors and
geometry, current text after a covered write, target-only video, retained video
after minimization, and ten minimized writes while the covering window keeps
focus. It does not establish physical typing, other GNOME releases, fractional
scales, KDE or all Wayland compositors. Retain `/tmp/gnome-recording` and the
PNG artifacts before removing the exited container.
