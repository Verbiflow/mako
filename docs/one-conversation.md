# A Thread is one conversation

Status: the store's split is built and tested, and off (`ThreadStoreOptions.oneConversation`). The windows still draw
Sessions as tabs. This page is the design for the whole change and says what landed first.

The person accepted the proposal on 2026-11-03 (`capy-ux.md`, decisions 1, 2, 5 and 6): "To the user this is a much
more understandable thing." It answers the incident of 2026-11-01, when "Please continue" went to a Cursor fork idle
for 20 days, one of 14 Sessions in the Thread "Thread Environments and Cloud".

## The model

A Thread is one conversation with one agent at a time, in one place.

- **A harness switch stays in the Thread.** It already is one Session: a hand-off adds a binding to the same journal,
  and the store's locators for that Session name both harnesses (`ref.lineage` carries the chain for display). In the
  person's store, 15 Sessions hold more than one harness this way. Nothing about them changes.
- **A fork is its own Thread in the same place.** Its header says "Forked from …" from `sessions.parent_session`.
- **A second conversation opened with `+` or Cmd+T is a new Thread in the same place.**
- **A Session stays what it is inside the host:** one logical conversation, its journals and native sessions, the unit
  of continuation and of moves. It leaves the UI.
- **The rail stops folding.** Every row is one Thread, so `foldThreads`, `FoldGlyph`, `MarkStack` and `SessionCount`
  have nothing to fold.
- **The workbench's tabs hold what's open across Threads**: Threads, Fins and files, each Thread tab wearing its live
  mark. No Session tabs.
- **The place is a chip in the Thread header**: the branch and worktree, its changes, its pull request.

## What the person's store holds today

Read from a copy of `~/.mako/threads.sqlite` on 2026-11-03 (a plain file copy into a scratch folder; the original was
never opened): 5,018 Threads, 102 of them with more than one Session, 226 Sessions in those, the largest the 14 of
"Thread Environments and Cloud". By origin, the Sessions in multi-Session Threads are 200 harness forks the catalog
found (`imported`), 20 `+` tabs (`new`), 2 Mako forks, 2 started and 2 captured. 16 of the 29 Fin edges hang off a
multi-Session Thread as parent; no Fin is itself a multi-Session Thread. No multi-Session Thread has a worktree yet.
One Session runs on a cloud machine. Two of the multi-Session Threads have a name the person gave them.

## Inventory: everything that knows a Thread holds several Sessions

"After" is the state once the split has run and the UI draws one conversation per Thread. "Migration" is what the
split does to the record; "nothing" means the record is keyed by something the split doesn't change.

### The Thread store (`packages/host/src/threads/store.ts`, `~/.mako/threads.sqlite`, shared by every host on the Mac)

| Record | Today | After | Migration |
|---|---|---|---|
| `threads` | One row per Thread; title, owner, `merged_into` | Same, one per conversation | A new row per split-off Session, id from `splitThreadId(thread, session)`, same owner, created when the Session was, untitled |
| `memberships` | Session → Thread with a tab `position` | Each live Thread has one member | Each Session after the first moves to its new Thread at position 0; the triggers log it in `placement_changes`, so other hosts forget only those placements |
| `sessions`, `journals`, `sources`, `locators`, `native_claims`, `executions` | Per Session | Same | Nothing. The test checks every row is byte-for-byte the same |
| `thread_worktrees` (+ `thread_worktree_repositories`) | One worktree per Thread per device | One owner per worktree; others share it through `thread_places` | Stays with the Thread that keeps its id |
| `thread_places` (new, migration 7) | n/a | Thread → the Thread whose place it works in, and why (`split`, `fork`, `new`) | One row per split-off Thread, naming its source |
| `thread_splits` (new, migration 7) | n/a | Each split-off Thread's source Thread, Session, old tab position and the source's title then | One row per split-off Thread; the way back reads it |
| `thread_purposes` | First purpose per Thread (setup) | Same | Stays with the Thread that keeps its id |
| `thread_parents` (Fin → Apex edges) | `parent_thread` and `record.parentSession` | Parent is the Thread holding `parentSession` | An edge whose parent Session split off follows it (row and `record.parent`). A child edge follows the Session its followed run is, else stays |
| `thread_reports` | By child Thread | Same | Follow their child edge |
| `agent_spawns` | Queued spawns by tree root | Same | Nothing; the tree's root keeps its id |
| `moves` | Move history by Thread | Same | Nothing; history stays with the Thread that keeps its id. A Thread with a move under way (`leaving`, `released`) isn't split until it ends |
| `title_*`, `original_title` | Per Thread | Same | Nothing; the keeping Thread keeps its name |
| `operations` | Receipts of `+`, adopt, merge | Same | Nothing; a replayed `+` receipt returns the placement it returned then |
| `groups()`, `group()`, `ThreadGroupSchema` (`sessions.min(2)`) | Threads of 2+ Sessions | Empty once split, except Threads left whole until they're here | Nothing to migrate; the contract retires with the UI step |
| `createSession` | Adds a `+` Session to the Thread | Mints a Thread beside it, in its place | Behind `oneConversation` |
| `mintDescendant` (`placement: "parent-thread"`) | A fork joins its parent's Thread | Every fork is a Thread in its parent's place | Behind `oneConversation` |
| `mintImported`, `adoptFork` | A harness's own fork joins its parent's Thread | Its own Thread in the parent's place; no adoption | Behind `oneConversation` |
| `adoptElsewhere` (fork of a cloud Thread's conversation) | Joins the cloud Thread | Unchanged until cloud Threads split | Cloud Threads are left whole (below) |
| `acceptThread` / `threadHandoff` (moves carry every Session of a Thread) | Several Sessions per handoff | One Session per handoff once split | Nothing; a Thread is split only while all of it is here |

### Other host records

| Record | Today | After | Migration |
|---|---|---|---|
| `threads/session-memory.ts` (`session-memory.sqlite`) | Per native session and conversation | Same | Nothing |
| `threads/worktree-origins.ts` (`worktree-origins.json`) | By worktree folder | Same | Nothing |
| `threads/archives.ts` (`thread-archives.sqlite`) | Archive keys per Session target (`live:`, `file:`, `native:`) | Same; a Thread is archived when its one Session is | Nothing: an archived Session's Thread is archived. The test checks it |
| `threads/lineage.ts` (`lineage.json`) | By native path | Same | Nothing |
| `threads/groups-follow.ts` | Emits `thread-group` changes to windows | Emits that each split Thread's group went (`group: null`) | Nothing; it notices the split like any regroup |
| `threads/group-methods.ts` (`threadGroups`, `threadCreateSession`) | Groups; `+` in a Thread | `threadCreateSession` returns the new Thread's placement | Behind `oneConversation`; the method's name retires with the UI step |
| `conversations/live-threads.ts` `placement()` | Reads the store at the edge, never the journal | Same | Nothing. A journal's own `threadId` is never trusted |
| `conversations/live-forks.ts` (`thread: "parent" | "new"`) | Parent's Thread, or a new one | Always a new Thread in the parent's place | The store decides; the argument retires with the UI step |
| `workspaces/thread-worktrees.ts` `threadCheckout` | Worktree of the conversation's Thread | Worktree of the conversation's Thread's place (`placeOf`) | Landed: a Thread with no `thread_places` row is its own place, so today's behaviour is unchanged |
| `workspaces/thread-worktrees.ts` receipts (`worktrees/receipts/{conversation}.json`) | By the conversation that made the worktree | Same | Nothing |
| `workspaces/thread-environment.ts` (app values) | By app (one per folder) | Same | Nothing; a folder's app is shared by every Thread in it, as it is now |
| `conversations/cloud-conversations.ts` (`cloud/conversations.json`) | Conversations and their Thread on a cloud machine | Same | Nothing: Threads that run elsewhere aren't split |
| `conversations/cloud-readiness.ts` (`cloud/ready.json`) | By local Thread | Same | Nothing; the Thread that keeps its id keeps its standby |
| Live journals (`conversations/{id}.sqlite`) | Hold `threadId`/`sessionId` as last stamped | Same | Nothing; the store is read at the edge (`LiveThreads.placement`) |

### The windows (`src/`)

| Record | Today | After | Migration |
|---|---|---|---|
| `src/lib/thread-fold.ts` | Folds rows sharing a Thread into one row | Removed | n/a |
| `src/state/thread-sessions.ts` | A Thread's tabs from its group, `+`, the Draft tab, `lastViewed` | A Thread's view is its one conversation; "new Thread here" replaces `+` | n/a (in memory) |
| `src/state/thread-groups.ts` groups, `threadOf`, `lastViewed` | In memory, from the host | Removed with the contract | n/a |
| `mako.thread-session-drafts.v1` (localStorage) | One new-tab draft per Thread, with the Session its send asked for | One "new Thread here" draft per place | `carryDrafts` (`contracts/thread-splits.ts`): a draft whose Session split off goes with it and keeps its text's key; one with no Session stays with the Thread that kept its id |
| `mako.session-drafts.v1`, `mako.attachment-drafts.v1`, `mako.pending-sends.v1` | By draft key (`thread-session:{thread}` for a new tab, else the conversation) | Same keys | Nothing; `carryDrafts` keeps the old key on a moved draft, so its text is found |
| `mako.prefs.v1` `pinnedThreads`, `titleOverrides` | By a Session's path (a folded row pins the path it showed) | By the row's path, which is now its Thread's one Session | Nothing: the pinned Session's Thread is pinned, its own title override stays its own |
| `src/state/thread-titles.ts` | Thread titles from the host | Same | Nothing |
| `src/state/thread-status.ts`, `thread-store.ts` | Status by path, folded per Thread | By path, one per row | n/a (in memory) |
| `src/state/notifications.ts`, `thread-siblings.ts` | Items carry `thread`; "other Sessions still working" | `threadSiblings` goes; items carry `thread` | n/a (in memory) |
| `src/state/session-panes.ts` (`mako:chat-panes`, sessionStorage) | Split panes by `{thread, tab}` | By Thread | Lost on the next window open at worst; it's per window session |
| `src/state/rail-ranks.ts` | Frozen ranks while dragging | Same, by row | n/a |
| `src/state/tabs.ts` | The window's open conversations | What's open across Threads (below) | n/a |
| `src/components/stage/session-tabs.tsx`, `rail/thread-row.tsx` (`SessionCount`, `MarkStack`, `FoldGlyph`) | Session tabs; folded rows | The workbench's open-item strip; one mark per row | n/a |

### The web client and the account

| Record | Today | After | Migration |
|---|---|---|---|
| `src/web-client/read-state.ts` (`mako:web:read:{account}`) | Seen activity by Thread id | Same | A split-off Thread is seen as it's first listed (`noteListed`), so nothing turns unread. A manual unread mark stays with the Thread that kept its id |
| `src/web-client/drafts.ts` | By conversation, or a new Thread's target | Same | Nothing |
| `packages/protocol/src/thread-listing.ts` | One row per Session with its Thread id | One row per Thread | Nothing; rows are published from the store, so they carry the new ids |
| Account archives (`threads/archives.ts` `account_archives`) | Cloud Threads' Session keys | Same | Nothing: cloud Threads aren't split |

## The split

`packages/host/src/threads/thread-split.ts`, run by the store's open (`create` → `migrate`) when `oneConversation` is on.

1. **Copy first.** Before the open takes its write lock, and only if there is a Thread to split and no copy yet,
   `keepPreSplitCopy` writes the whole store with `VACUUM INTO` to `threads.sqlite.before-one-conversation.partial`
   and renames it to `threads.sqlite.before-one-conversation`. A copy that exists is whole. It is never overwritten.
2. **One transaction.** The split runs inside the open's `BEGIN IMMEDIATE`, after migration 7 makes `thread_places`
   and `thread_splits`. A crash anywhere before `COMMIT` leaves the store as it was; SQLite's WAL rolls the partial
   transaction back on the next open. Other hosts wait on the lock as they do for any migration.
3. **Which Threads.** Every live Thread with more than one member, oldest first. A Thread whose Sessions don't all
   run here, or that has a move `leaving` or `released`, is left whole (`deferred`) and split at the first open once
   it's here again. The person's store has one such Thread.
4. **Who keeps the Thread.** The Session first in tab order keeps the Thread's id, title, purpose, worktree, move
   history and its edge as a child. It is the conversation the Thread was made for: the one its worktree, purpose
   and name were given to.
5. **The others.** Each other Session gets the Thread `splitThreadId(thread, session)` names: a version 8 UUID from a
   hash of the two ids, so every store that splits the same Thread names the result alike, and a split repeated after
   the way back makes the same Thread. Same owner, created at the Session's own creation time, so the rail sorts the
   split Threads newest first by the same rule it sorts every Thread. Untitled: each reads as the conversation it was,
   which is what its tab showed. `thread_splits` keeps where it came from and the source's title for the crumb
   ("Split from Thread Environments and Cloud"). `thread_places` points it at its source's place.
6. **Edges.** A Fin edge whose `parentSession` (following merges) is a split-off Session moves to that Session's
   Thread, row and record. A child edge whose followed run is one of the split-off Sessions (by `sources`,
   `native_claims` or `locators`) moves to it with its reports. Names stay unique: they were unique under the source.
7. **Stamp.** `store_meta.one-conversation` records when it ran and what it split. `store_migrations` has 7.

**Idempotent.** A store with nothing left to split is unchanged by an open; the test compares a digest of every row.
A Thread that gains a second Session later (an older build's `+` or fork, below) is split by the next open.

**Older builds.** The format stays 2 and reads 1: the new tables are additive and older builds ignore them. An older
build shows each split Thread as a row of its own, because it folds only by Thread. Its `+` and forks still put a
Session in an existing Thread; the next open of a build with `oneConversation` splits that Thread again. Its
worktree lookup goes by Thread, so a split-off Thread has no worktree there, and a fork made from it in an older build
starts in the folder its conversation already works in.

**The way back.** Two ways, by what the person wants back.

- **Groups back, nothing lost since.** `undoThreadSplits` returns each split-off Session to its source Thread at its
  old tab position, moves back the edges and reports that followed it, drops its place, and merges the split-off
  Thread into its source (`merged_into`), so anything that still names it reads the Thread it joined. A split-off
  Thread that holds anything else by then is left alone. Then switch `oneConversation` off. The test runs it on the
  fixture, the generated store and the copy of the person's store, and each comes back member for member.
- **The store as it was.** Quit every Mako, replace `threads.sqlite` (and remove its `-wal` and `-shm`) with
  `threads.sqlite.before-one-conversation`. What changed in the store since the split is lost; Sessions come back from
  their journals and the catalog, as after a damaged store.

## A shared place

Several Threads now work in one place: a split Thread's siblings, a fork, a `+` beside one. One of them owns it.

- **The owner** is the Thread holding the `thread_worktrees` row: the Thread the worktree was made for, or the one
  that kept the id at the split. Every other Thread in the place names the owner in `thread_places`; forks and new
  Threads name the owner of their source's place, so the chain is one hop.
- **Finding the place.** `placeOf(thread)` follows `thread_places` (and merges) to the owner. `threadCheckout` and
  `ofConversation` read the owner's worktree, so a fork's folder, the `mako` server's worktree status and the app
  resolve the same checkout for every Thread in the place. The header's place chip reads it too.
- **Removing the worktree.** As now: refused while any conversation runs anywhere in the checkout, sibling or owner
  (`held` asks every conversation holding the folder), and idle ones go on in the main checkout first
  (`conversations.leave`, by folder). Once the row goes, `detachWorktree` drops every `thread_places` row naming the
  owner, so no Thread inherits the owner's next worktree.
- **Moving one Thread.** Moves are per Thread and carry that Thread's one conversation. A Thread that moves out of a
  shared worktree (to the main checkout, another worktree, or the cloud) leaves the others where they are. A sibling
  that moves drops its `thread_places` row. When the owner moves away and siblings remain, the row passes to the
  sibling that worked there most recently, and the rest re-point to it; the worktree's folder and branch don't move.
  Both are the next host step; until they land, a move takes the Thread's worktree row with it as today, and a
  sibling keeps naming an owner that moved.
- **Archiving one Thread** archives its one Session. The worktree stays while any Thread in the place is unarchived.

## After the change

- **`+` in a Thread, and Cmd+T,** start a draft for a new Thread in the current Thread's place: same folder, same
  branch, the harness last used there. Nothing is made until the first send; the send's `threadCreateSession`
  returns the new Thread, which opens in the same tab. An empty draft goes when you leave it; one with text stays as a
  draft row under the project, its text kept per place.
- **Fork** (an exchange's Fork, the turn navigator's fork, a catalog fork) makes a Thread of its own in the parent's
  place, crumb "Forked from …", opened in a new tab beside its parent. Option-click no longer means anything different;
  it is dropped from the controls.
- **A harness switch** changes the Thread's mark at the hand-off; the header ghosts the earlier harness; no new row,
  no new tab.
- **Moves** are per Thread, as now. The place chip offers them; no control moves a Session.
- **Fins** are Threads with a parent edge, as now. Opening one opens a tab with its crumb ("Apex › Fin").

## The tab model

A tab is something open in this window, across Threads:

```ts
type OpenTab =
  | { kind: "thread"; thread: ThreadId }
  | { kind: "draft"; place: ThreadId }          // a new Thread here, before its first send
  | { kind: "file"; path: string; thread?: ThreadId }
  | { kind: "diff"; thread: ThreadId; path?: string }
```

- **What it shows.** A Thread or Fin tab wears the Thread's live mark (the same mark as its rail row) and title. A file
  tab names its file; a diff tab its Thread's changes.
- **Opening.** Clicking a rail row shows the Thread in the active tab if that tab is a Thread tab nobody has typed into,
  else focuses the Thread's tab if one is open, else opens a tab. Cmd-click and middle-click always open a new tab. A
  fork, a Fin opened from the crew card and a file open new tabs.
- **Persisting.** Per window in localStorage, `mako.open-tabs.v1.{profile}.{window}`: the list, the active tab and the
  version. A tab whose Thread is gone (archived elsewhere, merged) opens the Thread it was merged into or closes.
  The host's per-client workspace tabs (`workspaces/pool.ts`) stay what each conversation's workspace is; the strip is
  the window's.
- **What it replaces.** `session-tabs.tsx`, `threadSessionTabs`, the Draft tab and `lastViewed`. A Thread is opened, not
  one of its Sessions, so the incident can't happen: the tab you type into is the conversation the rail row is.

## What landed first, and what's left

Landed with this page:

- `thread-split.ts`: the split, its pre-split copy and its way back; migration 7's tables.
- The store: `oneConversation` (split on open, `+` and forks as Threads beside their source), `placeOf`,
  `threadSplits`, `detachWorktree` dropping a gone place.
- `threadCheckout` reading the place's worktree.
- `contracts/thread-splits.ts`: `carryDrafts`.
- `scripts/test-thread-split-migration.ts` (`npm run test:thread-split`, in `test:thread-store` and CI's orchestration
  job). `MAKO_SPLIT_REAL_COPY=<a copy>` adds a real store's copy to it.

`oneConversation` is read from `MAKO_ONE_CONVERSATION=1` and only on an isolated host, so no host on the person's
own data can split until the windows are ready.

Left, in this order, each its own pull request behind the same switch, turned on by the last:

1. **The host's last pieces.** A `threadSplits` method for windows; passing the place's owner on when it moves away
   (above); `forksOf` naming a harness's own forks for the crumb; `live-forks.ts` dropping `thread: "new"`.
2. **The windows read one conversation per Thread.** `rowThread` stops consulting groups; the rail stops folding
   (`foldThreads`, `FoldGlyph`, `MarkStack`, `SessionCount` go; `thread-row.tsx` and `active-threads.tsx` only lose
   their fold branches); the notifications drop `threadSiblings`. `test:rail-ui` and `test:workspace-ui` cover it.
3. **New Thread here.** `+` and Cmd+T start a draft in the place; forks open their own tab; Option-click goes;
   `carryDrafts` runs once over `mako.thread-session-drafts.v1` with the host's splits.
4. **The workbench's tabs** as above, replacing `session-tabs.tsx`, with the live mark from the rail's.
5. **The place chip** in the header, reading `placeOf`'s worktree.
6. **Turn it on.** `oneConversation` defaults on for every host (the isolation check goes); `AGENTS.md`'s Product
   surface is rewritten to match; `ThreadGroup` and `threadGroups` retire once no window reads them.
