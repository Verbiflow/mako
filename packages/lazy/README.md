# @mako/lazy

Packages loaded the first time something needs them, and one record per process
of what has loaded, when, for whom and at what cost. Requires Node 24 or newer.
It has no dependencies.

`lazyPackage(name, load)` declares a package; `load(reason)` imports it on the
first call and records the reason. A failed load stays failed, so every caller
gets the same error. `packageLoads()` lists every declared package, loaded or
not, and `onPackageLoad(listener)` reports each change of state.

The record lives on `globalThis`, so two copies of this module in one process
still record into one place.

## Private pipes on Windows

`@mako/lazy/private-pipe` is the one other thing here, because every package of
Mako's that listens on a Windows named pipe already depends on this one and it
depends on nothing: a pipe's name and secret drawn for one start of its server
and published in a file only its user can read, the handshake both ends of
every connection prove themselves with (`connectProven`, `requireProof`), and
locks held by an exclusively opened file. Nothing imports it off Windows' paths
but for those few functions, and no renderer imports it at all.
