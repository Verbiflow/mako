import { test } from "node:test"
import { runTrackerConformance, type MakeTracker } from "@mako/protocol/attribution-conformance"
import type { TrackerPorts } from "@mako/protocol/attribution"
import { LaptopTracker } from "@mako/host/attribution/tracker"
import { translating } from "./lib/translated-paths.mjs"

// The laptop tracker against the open contract's suite: a fake file system,
// a fake event source that drops events on purpose, and a hand-moved clock.
runTrackerConformance((ports) => LaptopTracker.open(ports), (name, body) => test(name, body))

// The same suite with every path written as Windows writes it, on whatever system this runs. The suite speaks of
// `/work/a.txt`; the tracker is told and tells of `C:\work\a.txt`, and asks its ports for that. So what the tracker
// does with a Windows path is checked on a Mac and on Linux too, case by case against the same expectations.
const toWindows = (path: string) => (path === "/work" || path.startsWith("/work/") ? `C:${path.replaceAll("/", "\\")}` : path)
const toSuite = (path: string) => (/^C:[\\/]work([\\/]|$)/.test(path) ? path.slice(2).replaceAll("\\", "/") : path)
const windows: MakeTracker = async (ports: TrackerPorts) =>
  translating(await LaptopTracker.open({ ...ports, fs: translating(ports.fs, toSuite, toWindows), events: translating(ports.events, toSuite, toWindows) }), toWindows, toSuite)
runTrackerConformance(windows, (name, body) => test(`${name} (Windows paths)`, body))
