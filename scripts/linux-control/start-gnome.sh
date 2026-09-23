#!/bin/sh
set -eu
mkdir -p "$XDG_RUNTIME_DIR" "$HOME/.local/share/gnome-shell/extensions/winrects@cua"
chmod 700 "$XDG_RUNTIME_DIR"
cp /helper/* "$HOME/.local/share/gnome-shell/extensions/winrects@cua/"
export CUA_DRIVER_REQUIRE_FOCUSED_TARGET=1 CUA_DRIVER_PERMISSION_MODE=unrestricted
export MAKO_RECORDING_DRIVER=/driver/cua-driver
exec dbus-run-session -- sh -c '
 set -eu
 gsettings set org.gnome.shell enabled-extensions "[\"winrects@cua\"]"
 gsettings set org.gnome.shell disable-user-extensions false
 gsettings set org.gnome.shell welcome-dialog-last-shown-version "46"
 gsettings set org.gnome.desktop.interface enable-animations false
 gnome-shell --wayland --headless --no-x11 --virtual-monitor 1280x900 >/tmp/gnome-shell.log 2>&1 &
 ready=0
 for n in $(seq 1 150); do
   for socket in "$XDG_RUNTIME_DIR"/wayland-*; do
     if [ -S "$socket" ]; then export WAYLAND_DISPLAY=${socket##*/}; ready=1; break; fi
   done
   [ "$ready" = 1 ] && gdbus call --session --dest org.cua.WinRects --object-path /org/cua/WinRects --method org.cua.WinRects.GetVersion >/tmp/helper-version.txt 2>/dev/null && break
   sleep .1
 done
 gdbus call --session --dest org.cua.WinRects --object-path /org/cua/WinRects --method org.cua.WinRects.GetVersion
 python3 /repo/scripts/linux-control/recording-fixture.py "Mako GNOME target" /tmp/gnome-target.json 2b5f8f >/tmp/fixture.log 2>&1 &
 "$MAKO_RECORDING_DRIVER" serve --no-overlay --dangerously-bypass-approvals --socket /tmp/mako-driver.sock >/tmp/driver.log 2>&1 &
 node /repo/scripts/linux-control/gnome-probe.mjs
'
