#!/bin/sh
# A private Linux desktop for desktop-probe.mjs: X11 (Xvfb and Openbox), or Wayland: headless Sway with XWayland and its
# ScreenCast portal through xdg-desktop-portal-wlr, PipeWire and WirePlumber; GNOME Shell; KWin 5 or 6. Each runs on
# its own session bus. Sway's portal chooser is set to the one output, so no dialog waits; GNOME's and KDE's dialogs
# are answered by portal-consent.py, as a person answers them once on their own desktop.
#
#   sh desktop-session.sh x11|sway|gnome|kde|kde6   (as an ordinary user; MAKO_DRIVER_DIR holds cua-driver, MAKO_EVIDENCE the results)
set -eu
kind=$1
export MAKO_DESKTOP="$kind"
here=$(cd "$(dirname "$0")" && pwd)
export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/tmp/mako-desktop-runtime-$(id -u)}
mkdir -p "$XDG_RUNTIME_DIR" && chmod 700 "$XDG_RUNTIME_DIR"
export PATH="$MAKO_DRIVER_DIR:$PATH" NO_AT_BRIDGE=0 GTK_MODULES=gail:atk-bridge CUA_DRIVER_RS_TELEMETRY_ENABLED=0
# A blinking caret repaints for ever (GTK 3 fades it, at the display's rate): the idle screen is measured without it.
mkdir -p "$HOME/.config/gtk-3.0"
printf '[Settings]\ngtk-cursor-blink=false\n' >"$HOME/.config/gtk-3.0/settings.ini"
case "$kind" in
x11)
  export DISPLAY=:93 XDG_SESSION_TYPE=x11 XDG_CURRENT_DESKTOP=openbox
  Xvfb "$DISPLAY" -screen 0 1280x800x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
  for _ in $(seq 1 100); do [ -S /tmp/.X11-unix/X93 ] && break; sleep .1; done
  exec dbus-run-session -- sh -c '
    set -eu
    openbox >/tmp/openbox.log 2>&1 &
    sleep 1
    exec node "$0/desktop-probe.mjs"
  ' "$here"
  ;;
sway)
  export XDG_SESSION_TYPE=wayland XDG_CURRENT_DESKTOP=sway WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 WLR_RENDERER=pixman
  mkdir -p "$HOME/.config/xdg-desktop-portal-wlr" "$HOME/.config/xdg-desktop-portal"
  printf '[screencast]\nchooser_type=none\noutput_name=HEADLESS-1\n' >"$HOME/.config/xdg-desktop-portal-wlr/config"
  printf '[preferred]\ndefault=wlr;gtk\n' >"$HOME/.config/xdg-desktop-portal/sway-portals.conf"
  exec dbus-run-session -- sh -c '
    set -eu
    printf "%s\n" "output HEADLESS-1 resolution 1280x800" "seat seat0 fallback true" "xwayland enable" >/tmp/sway.conf
    sway -c /tmp/sway.conf >/tmp/sway.log 2>&1 &
    for _ in $(seq 1 100); do
      for socket in "$XDG_RUNTIME_DIR"/wayland-*; do [ -S "$socket" ] && export WAYLAND_DISPLAY=${socket##*/}; done
      [ -n "${WAYLAND_DISPLAY:-}" ] && break
      sleep .1
    done
    for socket in "$XDG_RUNTIME_DIR"/sway-ipc*.sock; do [ ! -S "$socket" ] || export SWAYSOCK="$socket"; done
    # Sway starts XWayland on the first X client; its socket is there from the start.
    for _ in $(seq 1 50); do
      for socket in /tmp/.X11-unix/X*; do [ -S "$socket" ] && export DISPLAY=:${socket##*/X}; done
      [ -n "${DISPLAY:-}" ] && break
      sleep .1
    done
    dbus-update-activation-environment WAYLAND_DISPLAY XDG_CURRENT_DESKTOP SWAYSOCK DISPLAY XDG_SESSION_TYPE
    pipewire >/tmp/pipewire.log 2>&1 &
    sleep .5
    wireplumber >/tmp/wireplumber.log 2>&1 &
    /usr/libexec/xdg-desktop-portal-wlr >/tmp/xdpw.log 2>&1 &
    /usr/libexec/xdg-desktop-portal >/tmp/xdp.log 2>&1 &
    sleep 1
    exec node "$0/desktop-probe.mjs"
  ' "$here"
  ;;
gnome)
  # GNOME Shell headless with XWayland and its portal backend. The driver's Shell helper is installed the way a person
  # installs it: the host's own grant (desktop-grant.mjs, Settings' "Install helper"), then a login, which here is the
  # Shell's start. A person answers GNOME's consent dialogs; here portal-consent.py answers them through AT-SPI and
  # logs each, so a restored session shows none.
  export XDG_SESSION_TYPE=wayland XDG_CURRENT_DESKTOP=GNOME LIBGL_ALWAYS_SOFTWARE=1
  exec dbus-run-session -- sh -c '
    set -eu
    gsettings set org.gnome.shell disable-user-extensions false
    node "$0/desktop-grant.mjs"
    gsettings set org.gnome.shell welcome-dialog-last-shown-version "46"
    gsettings set org.gnome.desktop.interface enable-animations false
    gsettings set org.gnome.desktop.interface toolkit-accessibility true
    gsettings set org.gnome.desktop.interface cursor-blink false
    pipewire >/tmp/pipewire.log 2>&1 &
    sleep .5
    wireplumber >/tmp/wireplumber.log 2>&1 &
    gnome-shell --wayland --headless --virtual-monitor 1280x800 >/tmp/gnome-shell.log 2>&1 &
    for _ in $(seq 1 150); do
      for socket in "$XDG_RUNTIME_DIR"/wayland-*; do [ -S "$socket" ] && export WAYLAND_DISPLAY=${socket##*/}; done
      [ -n "${WAYLAND_DISPLAY:-}" ] && gdbus call --session --dest org.cua.WinRects --object-path /org/cua/WinRects --method org.cua.WinRects.GetVersion >/dev/null 2>&1 && break
      sleep .1
    done
    for socket in /tmp/.X11-unix/X*; do [ -S "$socket" ] && export DISPLAY=:${socket##*/X}; done
    dbus-update-activation-environment WAYLAND_DISPLAY XDG_CURRENT_DESKTOP DISPLAY XDG_SESSION_TYPE
    python3 "$0/portal-consent.py" "$MAKO_EVIDENCE/gnome-consent.jsonl" >/tmp/consent.log 2>&1 &
    exec node "$0/desktop-probe.mjs"
  ' "$here"
  ;;
kde | kde6)
  # KWin headless (5.27; Plasma 6.3 for kde6) on its virtual backend, with XWayland and the KDE portal backend; portal-consent.py answers its dialogs.
  export XDG_SESSION_TYPE=wayland XDG_CURRENT_DESKTOP=KDE KDE_FULL_SESSION=true KDE_SESSION_VERSION=$([ "$kind" = kde6 ] && echo 6 || echo 5) \
    QT_QUICK_BACKEND=software KWIN_COMPOSE=${MAKO_KWIN_COMPOSE:-O2ES} LIBGL_ALWAYS_SOFTWARE=1 XWAYLAND_NO_GLAMOR=1 XDG_MENU_PREFIX=plasma- QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1 QT_ACCESSIBILITY=1
  exec dbus-run-session -- sh -c '
    set -eu
    pipewire >/tmp/pipewire.log 2>&1 &
    sleep .5
    wireplumber >/tmp/wireplumber.log 2>&1 &
    # KWin 6, told this is a full Plasma session, waits for a session manager this headless desktop does not run; the
    # apps and the portal still see it.
    kbuildsycoca${KDE_SESSION_VERSION} >/tmp/sycoca.log 2>&1 || true
    env -u KDE_FULL_SESSION -u KDE_SESSION_VERSION kwin_wayland --virtual --xwayland --width 1280 --height 800 --socket wayland-mako --no-lockscreen --no-global-shortcuts \
      >/tmp/kwin.log 2>&1 &
    for _ in $(seq 1 150); do [ -S "$XDG_RUNTIME_DIR/wayland-mako" ] && break; sleep .1; done
    export WAYLAND_DISPLAY=wayland-mako
    for _ in $(seq 1 50); do
      for socket in /tmp/.X11-unix/X*; do [ -S "$socket" ] && export DISPLAY=:${socket##*/X}; done
      [ -n "${DISPLAY:-}" ] && break
      sleep .1
    done
    dbus-update-activation-environment WAYLAND_DISPLAY XDG_CURRENT_DESKTOP DISPLAY XDG_SESSION_TYPE KDE_FULL_SESSION \
      KDE_SESSION_VERSION QT_LINUX_ACCESSIBILITY_ALWAYS_ON QT_ACCESSIBILITY QT_QUICK_BACKEND XDG_MENU_PREFIX
    python3 "$0/portal-consent.py" "$MAKO_EVIDENCE/$MAKO_DESKTOP-consent.jsonl" >/tmp/consent.log 2>&1 &
    exec node "$0/desktop-probe.mjs"
  ' "$here"
  ;;
*)
  echo "usage: desktop-session.sh x11|sway|gnome|kde|kde6" >&2
  exit 64
  ;;
esac
