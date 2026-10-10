# claude-mods

Claude Code plugins for staying an informed developer while an agent writes the code: know what to review before a commit, check you understand what changed, stop the same friction coming back, and avoid paying a big model for small work.

Three are mods (function-hook plugins with a band, pane or gate); one is a skill. Each installs on its own.

| Plugin | Kind | What it does |
|---|---|---|
| [triage-gate](plugins/triage-gate) | mod | Judges each `git commit` Claude makes and holds the risky ones for review |
| [hindsight](plugins/hindsight) | mod | Notices snags that come back across sessions and proposes one fix to the environment |
| [model-fit](plugins/model-fit) | mod | Says when a model was too big or too small for an ask, and when the context got expensive |
| [quiz-me](plugins/quiz-me) | skill | Asks you one to three "what happens when…" questions on what the session changed |

## Install

Prerequisites:

- A Claude Code build with function-hook plugins (mods). These were built and tested against 2.1.296; the mod API is early access and can change between releases.
- Git, for triage-gate.
- For `/gate codex`: the Codex CLI, installed and logged in.
- Panes and bands draw only on surfaces that support them. The tests cover the terminal and, for the Triage pane, the desktop app; other surfaces are untested.
- For `/hindsight`'s hand-off: the `mattpocock-skills` plugin, which provides `/mattpocock-skills:retro`. This marketplace does not include it.

The repo is a plugin marketplace named `my-mods`. From the root of a clone:

```
claude plugin marketplace add .
claude plugin install triage-gate@my-mods
claude plugin install hindsight@my-mods
claude plugin install model-fit@my-mods
claude plugin install quiz-me@my-mods
```

A directory marketplace is read in place, so an edit here takes effect at the next session start or `/reload-plugins`.

## triage-gate

It is a mod rather than a skill because it has to intercept the commit, and its pane, live Codex progress and approval buttons are the workflow.

Before a commit Claude makes, it scores the change and gives one of three verdicts:

- **NO REVIEW TRIGGER**: nothing fired. This is not a claim that the change is safe.
- **READ IT**: the commit goes through, with a toast saying why to read it.
- **HOLD FOR REVIEW**: the commit is refused until you approve it.

The score comes from the blast radius (lines, files, areas, how many files use the changed one, build and schema files) and, with a TypeSafe key, from Jev's judgements (security, data, money, concurrency, public API, readability). Consequence is judged apart from size: a change to sensitive paths (auth, session, token, secret, permission, `.env` and similar) is never a pass, and a likely security change is held whatever its size. A line under the verdict says what it rests on: local checks only, a partial diff, or the whole diff with Jev.

Commands:

- `/gate` triages the uncommitted change and opens the Triage pane.
- `/gate approve` (or the pane's Approve button) approves the last triaged change, not a fresh one: edits made since that triage are not covered and will be held. Run `/gate` first if the change moved on.
- `/gate codex [focus]` runs a Codex review of at most 15 changed files: flagged ones first, then the largest. Findings show in the pane with a "Send to Claude" button. The review is marked stale when Claude edits a file with Edit or Write, or a later triage sees a different change. Edits by hand, by shell commands or by other tools are not noticed: run `/gate` after them.
- `/guide` puts a reading-guide request for the turn's files in the prompt box.

At the end of a turn it also raises a toast when the uncommitted change grows past a size level, once per level.

Setup:

```
claude plugin configure triage-gate@my-mods
```

The `typesafeApiKey` option is secret; `TYPESAFE_API_KEY` is the fallback. Without either, triage uses the blast radius alone. `codexModel` picks the Codex review model.

Note: with a key configured, each triage (a commit Claude makes, `/gate`, or "Triage again") sends the changed file paths and up to 60k characters of the diff to TypeSafe (api.typesafe.ai). A Codex review runs only on request and is billed to your Codex account.

## hindsight

It watches the main loop for three snags:

- many searches and reads before the first edit of a turn
- a command that fails, gets an edit, and fails again
- a very large tool output

Snags are kept per repo. When one comes back in a second session, one model call proposes a fix and its kind: a pointer line for `./CLAUDE.md`, a check, a standard, more information, or a cheaper way. A row above the prompt offers it:

- **Save** writes a pointer into a marked, size-capped section of `./CLAUDE.md`.
- **Put task in prompt** hands any other fix to Claude.
- **Skip** means not now: the snag is proposed again if it keeps coming back.
- **Not in this repo** mutes that snag for good.

A snag that comes back after its fix was saved or sent reopens as "back after a fix", and the next proposal is told what did not hold. Putting a task in the prompt does not run or verify the fix; you send it, and hindsight only learns whether it held if the snag comes back. `/hindsight` lists the repo's snags and puts `/mattpocock-skills:retro` with them in the prompt box (see Prerequisites).

## model-fit

Haiku labels each prompt you type as trivial, normal or complex, reading it together with the end of the last reply, so "yes please" is judged by the plan it approves.

- **After a simple ask on a bigger model than it needed**, the band says what the turn cost and what Haiku would have cost for the same tokens, with a button that puts `/model haiku` in the prompt box for the next ask like it.
- **While a complex ask runs on Haiku**, it warns that the answer may be thin and offers `/model opus`. On another model at low effort, it suggests raising the effort through `/model`.
- **As the context grows past a few size levels**, it says what each step costs and suggests `/clear` before a new task. After a long idle spell it adds what the next action costs while the cache is rebuilt.

All dollar figures are list-price estimates; `/cost` is the authority. `/fit` shows the typical steps and output per label, learned from your turns, and how many turns it suspects were mislabelled: those that ran over three times the steps their label predicts. `/fit reset` forgets them.

## quiz-me

```
/quiz-me:quiz
```

It asks one to three questions about what this session changed, one at a time, by the size of the change. You answer in your own words; it judges against the code and names the `file:line` that decides each answer. If the code does not do what you asked for, it says so as a finding. The score is not a merge verdict.

## Development

Check a plugin and the marketplace:

```
claude plugin validate plugins/<mod>
claude plugin test plugins/<mod>
claude plugin validate .
```

[HANDOFF.md](HANDOFF.md) holds the layout of a mod, the current state, open questions and API lessons; [docs/](docs) holds the hindsight plan and two reviews of the mods.
