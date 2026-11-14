# The delivery queue

Every message into a conversation is an entry in its journal's request queue
(`LiveRequest`), and `LiveDispatch` alone sends them. `contracts/request-hold.ts`
says why a held message waits (`holdOf`) and what goes next (`nextInLine`). This
note holds the rules a change to the queue must keep. A provider switch
(`ContextTransfer`) is queued work too, so the same rules cover it. A Thread moved
by an agent or by Mako (`continueOn`, `agents_move`) goes through the same switch,
with no message of its own: rules 10 to 12 are what's different about it. Rule 13 is how the queue closes what a Fin asked.
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
   as any message is. Resume sends the row's words through the switch. Whatever
   takes the row out of the queue takes the switch with it: a removal, Clear
   Queue, the Thread carrying it to the cloud, a remote cancel, a failed start.
   That's read at every write (`withdrawGone`, in `LiveConversations.flush`), so
   a new path can't leave a switch pending behind a row that will never go. While
   a switch's row is held, the switch holds nothing else up: a new message, or a
   new switch, goes ahead of it. A move is the exception: rule 12.

3. **A committed switch completes, a Stop or not.** Once the journal names the
   destination as the binding, the conversation is on it. The Stop pauses the
   switch's message with the rest of the queue, and the source goes on closing.

4. **Undo reverses only the switch's own binding effects.** When the source won't
   close, the session, the path, the bindings and the active binding go back
   (`undoSwitch`), and nothing else moves. A request's text, its holds and its
   place are untouched, whoever set them. It loses only the context that named the
   destination. The switch goes back to waiting behind its row, and its next
   attempt adopts that row instead of writing a new one. A move takes back what it
   did at commit as well: the pending context it left is dropped, so the source's
   next message doesn't carry the destination's transcript, and the rows it freed
   wait where they did. It doesn't go again: whoever asked is told.

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

9. **A turn a usage limit cut gives up its place, and takes one to go on.** Its wait
   can last days, so it holds no place and the Fin reads as its failure says. When
   its time comes it takes a place by the same limits as a start (`Agents.mayWake`).
   With no room it stays held, doesn't fail, and goes ahead of what's queued when one
   frees. A Stop while it waits stands.

10. **A move goes ahead of what's queued.** A move is a quiet switch: it has no
   message and no row, and nothing is taken over. What's queued is meant for its
   destination, so the switch doesn't wait for it (rule 7's order is for a switch
   with a message of its own), and no row goes on the source meanwhile. Every row
   goes on the target once it commits, in its order, the transcript with the first
   to go (a pending merge). `ThreadMove.first` names a row that goes ahead of what
   waited longer, as a held digest does. A move that fails leaves every row where
   it was, on the source. A move naming an account pins its binding there, a session
   it goes back to as much as a new one, and every later launch reads that pin. It
   goes back to a session another account made only where its harness goes on under
   another account (`accountContinuation`); elsewhere it takes a session of its own.
   A move naming none goes back to that session on the account it has.

11. **A hold about the source's account goes with the switch; a hold about the
    person doesn't.** A retry on its limit and a sign-out's hold belong to the
    account the Thread is leaving, and mean nothing on the target. So when any
    switch lands on another harness or account, a person's or a move, those rows
    go, and the sign-in notice with them. A switch's message goes ahead of them
    with the transcript, and a digest that was held with them goes ahead of that,
    taking the transcript with it. Landing on the very
    account that signed out changes nothing, and its hold stays. A Stop and a
    person's edit stay whatever the switch: a row a Stop paused while it waited on
    a sign-in stops waiting on the sign-in and goes on waiting for its Resume
    (`arriving`). A close that fails puts back what it freed, but only rows still
    as the landing left them: a Resume, an edit or a Stop since stands (`departing`).

12. **A Stop retires a move not yet committed.** This is the one exception to
    rule 2. A move has no row to be held in and never owns one, so it can't wait
    with a message: it goes no further, no binding comes after the Stop, and
    whoever asked is told, and can ask again. That holds from the moment it's asked,
    not from its admission: a Stop that lands while it resolves its selection or
    reads its history declines it, and what a person asked for in that window is
    accepted and held, as rule 2 says. A move asked for after a Stop can go,
    since it sends nothing: the Stop's holds stay, the Thread stays stopped, and
    what it paused goes on the target at its Resume. An automatic move yields
    instead (`unlessStopped`), and what it was decided on is read at its admission
    and again right before its commit, with nothing awaited between
    (`stillDecided`). A restart retires one too, since what it was decided on went
    with the last host, and whoever asked hears.

13. **A Fin's question closes when input reaches it.** When its harness takes a
    message or a steer after the Fin asked, from anyone, an Apex's or the person's,
    its question is answered, whatever the words, and an answer sent after that is
    refused as answered. An Apex's message answers only a question that has reached
    that Apex: one that crossed it, with the question waiting or being sent but not
    yet handed over, is just a message, and the question goes on to the Apex. Queueing isn't delivery: a
    message removed unheard leaves the question open. What Mako sends by itself (a digest, a continuation, a goal's
    step) answers nothing, known by where it came from, never by its words. An answer still on its way that fails doesn't reopen a
    question something else closed (`Agents.inputDelivered`).

14. **A digest that asks something doesn't wait out the minute's budget.** The
    budget (`WAKES_PER_MINUTE`) holds what's only news. A digest with a question or
    a decision in it (`digestAsks`) goes past a spent budget at most every
    `ASK_EVERY_MS`, and what's asked meanwhile joins it, so a Fin asking during each
    Apex turn gathers into one wake and doesn't loop. One joining a digest the budget
    holds takes that digest along. Otherwise a question could outwait the minute its
    Apex has to answer (`APEX_ANSWER_MS`), and the person would be asked first.

15. **A digest cut at its hand-off goes again.** Its reports read as heard once it's
    in the queue, so a crash after `submitted` and before the harness has it would
    lose them. The next host sends it again, framed as maybe repeated, unless the
    harness's transcript shows that very message by its id: a digest's words prove
    nothing, as any of them may be in what the Thread was told before. It goes again
    as a digest, so it waits out a limit and rests like any other, and later news goes
    on its own behind it (`cutBrief`, `DIGEST_AGAIN`).

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
| Move: destination won't open | `failed` | every row where it was, on the source |
| Move: Stop before commit | `failed`, `removed` | every row where it was, held by the Stop |
| Move: Stop after commit | `accepted` | every row on the target, held by the Stop |
| Move: close fails | `failed`, `removed` | every row back where it was, no pending context |
| Move: restart or crash before commit | `failed`, `removed` | every row where it was |
