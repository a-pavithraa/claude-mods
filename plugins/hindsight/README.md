# hindsight

It is a mod rather than a skill because it has to watch every tool call, which a skill cannot, and a fix is offered as a row you answer with a click, not a question Claude has to remember to ask.

It watches the main loop for snags that waste a session, each one a kind the retro skill can fix in the environment:

- many searches and reads before the first edit of a turn
- a command that fails, gets an edit, and fails again
- the same command failing 3 times in a row with no edit between: a tool quirk the agent does not know (a red, edit, red test cycle is not this)
- a very large tool output, unless the same file is edited in that turn: reading a file whole to change it is the work
- a shell call that takes over a minute
- a call refused at the permission prompt, by you or auto mode

Snags are kept per repo, named by the file searched most (or the folder the searches share), by the command, or by each program and its target. Each keeps the calls that showed it, one per session, and what it cost there: searches, failures, tokens (characters ÷ 4), seconds or refusals.

When a snag comes back in a second session, one model call proposes a fix and its kind: a pointer line for `./CLAUDE.md`, a check, a standard, more information, a cheaper way, or a settings change such as a permission rule. It is told the calls, what the kind of snag usually means, and for a large read the current sizes in that folder, so a proposed check fits the repo as it is. A large read whose file has since dropped under the limit is not proposed. A row above the prompt offers the fix with what the snag costs a session:

- **Save** writes a pointer into a marked, size-capped section of `./CLAUDE.md`.
- **Put task in prompt** hands any other fix to Claude.
- **Skip** means not now: the snag is proposed again if it keeps coming back.
- **Not in this repo** mutes that snag for good.

After a fix is saved or sent, hindsight counts the sessions in that repo without the snag. Five make the fix **held**. A snag that comes back first reopens as "back after a fix", with its cost then and before, and the next proposal is told what did not hold. Putting a task in the prompt does not run or verify the fix; you send it.

`/hindsight` lists the repo's snags grouped by what happens next (fix proposed, waiting for a 2nd session, fix in progress, fixes that held), each with how often it was seen and what it costs, and puts `/mattpocock-skills:retro` with them and their calls in the prompt box (see [Install](../../README.md#install)).
