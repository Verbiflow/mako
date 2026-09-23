"""Wait for the test desktop's actual X11/WM readiness, with a bounded deadline."""
import re
import subprocess
import sys
import time

mode = sys.argv[1]
deadline = time.monotonic() + 10
last = ""

def verify_managed_window():
    # EWMH owner properties can be published before the WM services map requests.
    # Prove a real window is managed before starting the driver/app acceptance.
    import gi
    gi.require_version("Gtk", "3.0")
    gi.require_version("GdkX11", "3.0")
    from gi.repository import Gtk, GdkX11
    window = Gtk.Window(title="Mako desktop readiness")
    window.set_default_size(80, 40)
    window.show_all()
    xid = GdkX11.X11Window.get_xid(window.get_window())
    diagnostic = ""
    try:
        while time.monotonic() < deadline:
            while Gtk.events_pending():
                Gtk.main_iteration_do(False)
            result = subprocess.run(
                ["xprop", "-root", "_NET_CLIENT_LIST"],
                capture_output=True, text=True, timeout=2,
            )
            diagnostic = result.stdout + result.stderr
            clients = [int(value, 16) for value in re.findall(r"0x[0-9a-fA-F]+", result.stdout)]
            if result.returncode == 0 and xid in clients:
                return
            time.sleep(0.025)
        raise SystemExit(f"Test window manager did not manage readiness window {xid}: {diagnostic}")
    finally:
        window.destroy()
        while Gtk.events_pending():
            Gtk.main_iteration_do(False)

while time.monotonic() < deadline:
    result = subprocess.run(
        ["xprop", "-root", "_NET_SUPPORTING_WM_CHECK"],
        capture_output=True, text=True, timeout=2,
    )
    last = result.stdout + result.stderr
    if result.returncode == 0:
        if mode == "server":
            sys.exit(0)
        match = re.search(r"window id # (0x[0-9a-fA-F]+)", result.stdout)
        if match:
            owner = subprocess.run(
                ["xprop", "-id", match[1], "_NET_SUPPORTING_WM_CHECK", "_NET_WM_NAME"],
                capture_output=True, text=True, timeout=2,
            )
            if owner.returncode == 0 and match[1] in owner.stdout and "Openbox" in owner.stdout:
                verify_managed_window()
                sys.exit(0)
    time.sleep(0.05)
raise SystemExit(f"Test desktop {mode} did not become ready: {last}")
