import { test } from "node:test"
import { runTrackerConformance } from "@mako/protocol/attribution-conformance"
import { LaptopTracker } from "@mako/host/attribution/tracker"

// The laptop tracker against the open contract's suite: a fake file system,
// a fake event source that drops events on purpose, and a hand-moved clock.
runTrackerConformance((ports) => LaptopTracker.open(ports), (name, body) => test(name, body))
