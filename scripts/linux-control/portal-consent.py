# Test-only: answers the GNOME and KDE 6 portals' consent dialogs as a person at the desktop would, through AT-SPI, and
# logs each answer. It picks the first monitor or window the dialog lists, then presses the button that shares or
# allows. A restore token means the dialog doesn't come back; the log shows how many times it was answered. A dialog it
# has no answer for is logged once as it is offered, so a new desktop's dialog can be read from the evidence.
#
#   python3 portal-consent.py /tmp/consent.jsonl
import json
import sys
import time

import gi

gi.require_version("Atspi", "2.0")
from gi.repository import Atspi  # noqa: E402

log = open(sys.argv[1], "a", buffering=1)
ANSWERS = ("Share", "Allow", "Share Screen", "Allow Remote Interaction", "Approve")
# KDE's dialog lists each thing to share as a button or check box named for it, beside ones that share something else.
KDE_NOT_A_SCREEN = ("New Virtual Output", "Rectangular Region", "Share virtual screen", "Share region", "Remove", "Clear search", "Cancel", "Deny", "Allow restoring on future sessions", "")
SOURCE_ROLES = (Atspi.Role.LIST_ITEM, Atspi.Role.RADIO_BUTTON, Atspi.Role.CHECK_BOX, Atspi.Role.TOGGLE_BUTTON)


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


def describe(nodes):
    """The dialog as it is offered: every named or pressable thing, with whether it can be pressed now."""
    seen = []
    for node in nodes:
        try:
            action = node.get_action_iface()
            actions = action.get_n_actions() if action else 0
            if node.get_name() or actions:
                states = node.get_state_set()
                seen.append(f"{node.get_role_name()}:{node.get_name()}:{'sensitive' if states.contains(Atspi.StateType.SENSITIVE) else 'insensitive'}:{'checked' if states.contains(Atspi.StateType.CHECKED) else ''}:{actions}")
        except Exception:
            continue
    return seen[:80]


def answer(name, window):
    nodes = list(walk(window))
    kde = "kde" in name.lower()
    named = [(node, node.get_role(), node.get_name() or "") for node in nodes]
    buttons = [node for node, role, label in named if role == Atspi.Role.PUSH_BUTTON and label in ANSWERS]
    if not buttons and kde:
        # Plasma 6.7's share dialog has no button to confirm with: each screen is a button that shares it.
        for node, role, label in named:
            if role == Atspi.Role.PUSH_BUTTON and label not in KDE_NOT_A_SCREEN and sensitive(node) and press(node):
                return ("pressed", label)
    if not buttons:
        return ("unanswered", describe(nodes)) if len(nodes) > 3 else None
    button = buttons[0]
    if not sensitive(button):
        # A source to share: KDE's entry for the first real screen, else the first monitor or window row, or its
        # radio or check button.
        for node, role, label in named:
            chosen = (role in (Atspi.Role.PUSH_BUTTON, Atspi.Role.CHECK_BOX) and label not in ANSWERS + KDE_NOT_A_SCREEN) if kde else role in SOURCE_ROLES
            if chosen and press(node):
                break
        time.sleep(0.3)
    label = button.get_name()
    if sensitive(button) and press(button):
        return ("pressed", label)
    return ("waiting", describe(nodes))


described = set()
while True:
    try:
        desktop = Atspi.get_desktop(0)
        for index in range(desktop.get_child_count()):
            app = desktop.get_child_at_index(index)
            name = app.get_name() or ""
            if "portal" not in name.lower():
                continue
            for window in [app.get_child_at_index(i) for i in range(app.get_child_count())]:
                title = window.get_name()
                result = answer(name, window)
                if result is None:
                    continue
                kind, detail = result
                # A dialog with no answer here is logged once per state it is seen in, not every poll.
                if kind != "pressed" and (name, title, kind, len(detail)) in described:
                    continue
                described.add((name, title, kind, len(detail)))
                log.write(json.dumps({"at": time.time(), "app": name, "window": title, kind: detail}) + "\n")
    except Exception as error:  # a dialog that closed between the walk and the press
        print(f"skipped: {error}", file=sys.stderr)
    time.sleep(0.2)
