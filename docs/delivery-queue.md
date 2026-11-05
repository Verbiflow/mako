# The delivery queue

Every message into a conversation is an entry in its journal's request queue
(`LiveRequest`), and `LiveDispatch` alone sends them. `contracts/request-hold.ts`
says why a held message waits (`holdOf`) and what goes next (`nextInLine`). This
note holds the rules a change to the queue must keep. A provider switch
(`ContextTransfer`) is queued work too, so the same rules cover it.
`npm run test:switch-interleavings` checks them after every step of generated
schedules, and a failing schedule is pinned there.

## The rules

1. **A Stop holds everything that hasn't gone.** Nothing sends after a Stop until
   a deliberate resume: Resume on the row, a Fin's `resumeHeld`. That stays true
   across a restart and a crash. A message the person sends after the Stop goes,
   ahead of what the Stop paused. It isn't held by the earlier Stop.

2. **A switch not yet committed is queued work, and a Stop holds it like any
   message.** Whether it's waiting behind another switch, waiting to go again, or
   under way, its message enters the queue as a held row (`holdSwitches`), and the
   switch waits with that row. From there the row is edited, removed and resumed
   as any message is. Resume sends the row's words through the switch. Removing
   the row takes the switch with it (`LiveTransfers.withdraw`). While a switch's
   row is held, the switch holds nothing else up: a new message, or a new switch,
   goes ahead of it.

3. **A committed switch completes, a Stop or not.** Once the journal names the
   destination as the binding, the conversation is on it. The Stop pauses the
   switch's message with the rest of the queue, and the source goes on closing.

4. **Undo reverses only the switch's own binding effects.** When the source won't
   close, the session, the path, the bindings and the active binding go back
   (`undoSwitch`), and nothing else moves. A request's text, its holds and its
   place are untouched, whoever set them. It loses only the context that named the
   destination. The switch goes back to waiting behind its row, and its next
   attempt adopts that row instead of writing a new one.

5. **The person's edits always win.** An edit Mako acknowledged stands whatever
   happens to the switch that carries the message: an undo, a retry, a failure, a
   crash. A failed switch's retry carries the words the message has now. Saving an
   edit isn't a resume: a message the Stop held stays held. A message removed stays
   removed.

6. **A switch's message has one home.** Before a Stop or a commit it's the
   switch's `input`. After either it's the row, and the row is the only copy that
   can go. A row whose switch is still pending never goes on its own: it goes on
   the destination, once that switch commits. A switch that fails for good takes
   its row back into its `input`, so its card's retry can't send the words twice
   and they never go on the harness the person was leaving.

7. **One switch at a time.** Only one switch is ever `preparing`, and `preparing`
   means an attempt is running. A switch asked for while another commits waits
   behind it (`behind`), after that one's message.

8. **There's always a binding the conversation can use.** The active binding is
   always one of its bindings. A failed destination leaves the source as it was,
   and a failed close puts it back.

## What each failure leaves

| What happened | The switch | Its message |
| --- | --- | --- |
| Stop before commit | `queued` | a held row, by the Stop |
| Stop after commit, close succeeds | `accepted` | its row, held by the Stop |
| Stop after commit, close fails | `queued` | its row, held by the Stop, as the person left it |
| Close fails, no hold, for now | `queued`, with `retry` | its row, waiting for the switch |
| Close fails, no hold, for good | `failed` | back in `input`, with its current words |
| Close fails, the person is editing | `queued` | its row, still theirs, the switch waiting on it |
| Close fails, the person removed it | `failed`, `removed` | gone |
| Restart or crash, switch not committed, row in queue | `queued` | its row, paused until Resume |
| Crash after commit, message unsent, not held | `failed` | the row reads failed, and the card's retry has its current words |
| Crash after commit, held by the Stop | `accepted` | its row, still held, and Resume wakes the destination |
