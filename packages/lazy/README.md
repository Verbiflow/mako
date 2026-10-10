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
