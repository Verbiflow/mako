# Test-only: answers the GNOME portal's consent dialogs as a person at the desktop would, through AT-SPI, and logs each
# answer. It picks the first monitor or window the dialog lists, then presses Share (screen cast) or Allow/Share
# (remote desktop). A restore token means the dialog doesn't come back; the log shows how many times it was answered.
#
#   python3 portal-consent.py /tmp/consent.jsonl
import json
import sys
import time

import gi

gi.require_version("Atspi", "2.0")
from gi.repository import Atspi  # noqa: E402

log = open(sys.argv[1], "a", buffering=1)
ANSWERS = ("Share", "Allow", "Share Screen", "Allow Remote Interaction")


def walk(node, depth=0):
    if node is None or depth > 40:
        return
    yield node
    for index in range(node.get_child_count()):
        try:
            yield from walk(node.get_child_at_index(index), depth + 1)
        except Exception:
            continue


def sensitive(node):
    return node.get_state_set().contains(Atspi.StateType.SENSITIVE)


def press(node):
    action = node.get_action_iface()
    if action and action.get_n_actions() > 0:
        action.do_action(0)
        return True
    return False


answered = set()
while True:
    desktop = Atspi.get_desktop(0)
    for index in range(desktop.get_child_count()):
        app = desktop.get_child_at_index(index)
        try:
            name = app.get_name() or ""
        except Exception:
            continue
        if "portal" not in name.lower():
            continue
        for window in [app.get_child_at_index(i) for i in range(app.get_child_count())]:
            try:
                nodes = list(walk(window))
            except Exception:
                continue
            buttons = [n for n in nodes if n.get_role() == Atspi.Role.PUSH_BUTTON and (n.get_name() or "") in ANSWERS]
            if not buttons:
                continue
            key = (name, window.get_name(), id(window))
            button = buttons[0]
            if not sensitive(button):
                # A source to share: the first monitor or window row, or its radio or check button.
                for node in nodes:
                    if node.get_role() in (Atspi.Role.LIST_ITEM, Atspi.Role.RADIO_BUTTON, Atspi.Role.CHECK_BOX, Atspi.Role.TOGGLE_BUTTON) and press(node):
                        break
                time.sleep(0.2)
            if sensitive(button) and press(button):
                log.write(json.dumps({"at": time.time(), "app": name, "window": window.get_name(), "pressed": button.get_name()}) + "\n")
                answered.add(key)
    time.sleep(0.2)
