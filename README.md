# claude-mods

Claude Code plugins for staying an informed developer while an agent writes the code: know what to review before a commit, check you understand what changed, stop the same friction coming back, and avoid paying a big model for small work.

Four are mods (function-hook plugins with a band, pane or gate); one is a skill. Each installs on its own.

| Plugin | Kind | What it does |
|---|---|---|
| [triage-gate](plugins/triage-gate) | mod | Judges each `git commit` Claude makes and holds the risky ones for review |
| [hindsight](plugins/hindsight) | mod | Notices snags that come back across sessions and proposes one fix to the environment |
| [toolbelt](plugins/toolbelt) | mod | Counts which skills and MCP servers you use and lists the unused ones that cost tokens every turn |
| [model-fit](plugins/model-fit) | mod | Says when a model or effort was too big or too small for an ask, and when the context got expensive; `/model-fit:baton` writes a handoff note |
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

Installing copies each plugin into `~/.claude/plugins/cache/my-mods/<plugin>/<version>/`, and sessions run that copy. An edit here reaches them only after a version bump in the plugin's `plugin.json` and:

```
claude plugin marketplace update my-mods
claude plugin update <plugin>@my-mods
```

then a new session.

## triage-gate

It is a mod rather than a skill because it has to intercept the commit, and its pane, live Codex progress and approval buttons are the workflow.

Before a commit Claude makes, it scores the change and gives one of three verdicts:

- **No review trigger**: nothing fired. This is not a claim that the change is safe.
- **Review recommended**: the commit goes through, with a toast saying why to read it.
- **Hold: review before commit**: the commit is refused until you approve it.

The verdict comes from the blast radius (lines, files, areas, how many files use the changed one, build and schema files) and, with a TypeSafe key, from Jev's judgements (security, data, money, concurrency, public API, readability). Consequence is judged apart from size: a change to sensitive paths (auth, session, token, secret, permission, `.env` and similar) is never a pass, and a likely security change is held whatever its size.

The Triage pane leads with the verdict and what it means, a one-line summary of the change (files, lines added and removed, areas), and what the assessment rests on: the whole diff with Jev, part of it, or local checks only, with the reason Jev was not used. Then come **Why**, the concrete reasons, and **Start with**, up to five files to inspect first, each with its reason (sensitive code, build or schema, widely used, biggest change). If the change is edited after the assessment, the pane says it is stale, hides **Approve commit** and makes **Refresh assessment** the main button. **Detailed signals** is folded by default: each Jev signal as a word and a percentage with what it measures, risk and tests apart, and a diagnostics line (who judged, how long Jev took, when it ran). The API key is never shown.

Commands (each works without the pane):

- `/gate` triages the uncommitted change and opens the Triage pane. The pane's **Refresh assessment** does the same.
- `/gate details` prints the pane's content as text: reasons, files to start with, Jev's signals and diagnostics.
- `/gate approve` (or the pane's **Approve commit**) approves the last triaged change and says "Approved. Ask Claude to run the commit again." It first checks the change against the assessment: if anything was edited since, it approves nothing, marks the assessment stale and asks you to run `/gate` again. The pane approves only the assessment it is showing. An approval covers the same files with the same content however the commit is made, so approving the working tree with new files still holds once those files are staged.
- `/gate codex [focus]` (or the pane's **Run Codex review**) runs a Codex review of at most 15 changed files: flagged ones first, then the largest. Findings show in the pane with a "Send to Claude" button. The review is marked stale when Claude edits a file with Edit or Write, or a later triage sees a different change. Edits by hand, by shell commands or by other tools are not noticed: run `/gate` after them.
- `/guide` puts a reading-guide request for the turn's files in the prompt box.

At the end of a turn it also raises a toast when the uncommitted change grows past a size level, once per level.

Setup:

```
claude plugin configure triage-gate@my-mods
```

The `typesafeApiKey` option is secret; `TYPESAFE_API_KEY` is the fallback. Without either, triage uses the blast radius alone. `codexModel` picks the Codex review model.

Note: with a key configured, each triage (a commit Claude makes, `/gate`, or "Triage again") sends the changed file paths and up to 60k characters of the diff to TypeSafe (api.typesafe.ai). A Codex review runs only on request and is billed to your Codex account.

## hindsight

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

`/hindsight` lists the repo's snags grouped by what happens next (fix proposed, waiting for a 2nd session, fix in progress, fixes that held), each with how often it was seen and what it costs, and puts `/mattpocock-skills:retro` with them and their calls in the prompt box (see Prerequisites).

## toolbelt

Lists the plugins, skills and MCP servers nobody used in 14 days, dearest first, so you can disable or remove them. Change the window with `claude plugin configure toolbelt@my-mods` (7, 14, 30, 60 or 90 days). It does not judge whether a skill is good; it counts use.

Plugins and skills are judged by the usage counters Claude Code keeps in `~/.claude.json` (the ones `/skill-doctor` reads), so the list agrees with Claude Code and `/unused` answers at once; nothing is read from transcripts. Those counters are internal: if they cannot be read the pane says skills are not judged. Nothing there counts MCP use, so Toolbelt counts server calls itself from the first session and lists a server only once that tracking is as old as the window. A server's scope (user, project, local) is read from `.mcp.json` and the same config, and a project or local server is unused per repo.

A plugin is one row, because its skills can only be switched off together; it is listed only if none of its skills was used. A toast says how many are unused and what they cost per turn, at most once a day and only when the list changed. `/unused` opens the pane:

- A plugin: **Disable** runs `claude plugin disable` on its `name@marketplace` id (all its skills go; it stays installed). **Uninstall…** asks again. `anthropic-skills`, which the desktop app syncs from your account, offers Disable only.
- A user skill: **Disable** moves its folder to `~/.claude/skills-disabled`; **Enable** moves it back.
- An MCP server: the CLI has no disable, so the button is **Remove** (`claude mcp remove`), which also deletes its env and keys.
- Each row has a mark and a bar for how many tokens it adds to every prompt; the dearest stand out. The list is paged, 8 to a page. A terminal narrower than 110 columns cannot seat the pane, so `/unused` shows the top 15 as a notice instead.
- **Keep** mutes an item for good. Items Toolbelt can't change (built-in, claude.ai connectors, plugin-bundled servers) are left off the list.

Every action asks a second time and takes effect in the next session. Actions run the `claude` CLI; no config file is edited by hand.

## model-fit

Haiku labels each prompt you type as trivial, normal or complex, reading it together with the end of the last reply, so "yes please" is judged by the plan it approves. A concept or arithmetic question that needs no code read ("what is a hashmap") counts as trivial.

- **After every ask you type**, one dim line says what it looked like, the model it ran on, what it cost and who judged it: `◇ Looked routine · Opus/high · ≈ $0.04 · judged by Haiku`. A silent band no longer leaves you guessing whether the mod ran.
- **Each label has a model and effort it needs**: trivial → Haiku at low effort, normal (routine) → Sonnet at medium, complex → Opus at high.
- **After a simple ask on a bigger model than Haiku, or a routine ask on Opus or Fable**, the advice weighs what switching itself costs. Prompt caches are per model, so `/model haiku` or `/model sonnet` mid-conversation makes the new model re-cache the whole conversation once, at 2x the input price on the one-hour cache or 1.25x on the five-minute one (and on Haiku, every price is five times higher above 100k tokens). Routine-ask advice shows once a session, since most asks are routine. A second Haiku call judges whether the ask needed the conversation:
  - **It didn't** ("what is a hashmap", "2 plus 2") and the conversation is long: ask such questions in a **new session** on Haiku. No switch, no re-cache, and the shown price is for that.
  - **It did**, and the re-cache pays back on the next ask like it: switch, with a button that puts `/model haiku` in the prompt box.
  - **It did**, and it pays back only over 2 to 4 asks: it says how many, so you switch only if a run of simple asks is coming.
  - **It did**, and it would take more than that: **stay**. It shows the re-cache cost and how many asks it would take to earn back, and suggests starting your next new task on the smaller model.
- **When only the effort was higher than the ask needed**, it suggests `/effort low` (simple) or `/effort medium` (routine), with a button. On Opus 5.5, Sonnet 5.5, Haiku 5.5 and Fable 5.1, with an API key or a subscription, an effort change keeps the cache, so this is offered at any context size and beside "stay". Elsewhere (Bedrock, Agent Platform, Foundry, Claude Platform on AWS, a custom `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`) it rebuilds the cache, so it is offered only below 50k tokens. The saving is not priced: Anthropic publishes no output per effort level.
- **After a long pause** (past the cache lifetime), the cache has expired on every model, so the context alert says that is the cheapest moment to change model.

- **While a complex ask runs on Haiku**, it warns that the answer may be thin and offers `/model opus`, with what moving the conversation to Opus costs once; a routine ask on Haiku gets the same for `/model sonnet`, once a session. A complex ask at low effort gets `/effort high`, and says whether that keeps the cache.
- **As the context grows past a few size levels**, it says what each step costs and how to shrink it: `/clear` for a new task, `/compact` or `/model-fit:baton` for the same task, `/rewind` after a wrong turn. Buttons put `/compact keep:` or `/model-fit:baton` in the prompt box. After a long idle spell it adds what the next action costs while the cache is rebuilt, and says to shrink first.
- **`/model-fit:baton`** writes a handoff note to the OS temp folder (or a path you give): next action first, verified versus assumed state, decisions with rejected options, gotchas, pointers, and the skills to invoke next. It writes in plain ASD-STE100 style and gives the line to paste after `/clear`.

All dollar figures are list-price estimates; `/cost` is the authority. `/fit` shows the typical steps and output per label, learned from your turns, and how many turns it suspects were mislabelled: those that ran over three times the steps their label predicts. It also totals the session: what the judged asks cost, how many were simple and how many of those did not need the conversation, and an estimate of the Haiku labelling itself (two small calls per ask; the mod API does not report their usage, so it is guessed from their length).

Assumptions behind the figures: list prices from Anthropic's pricing page (2026-10-12): cache reads at 0.1x input on Haiku, 0.05x on Sonnet and Opus, 0.025x on Fable; older Opus and Sonnet versions are priced as current ones. Another model's price assumes it writes the same output. The cache lifetime follows Claude Code's rules: `FORCE_PROMPT_CACHING_5M`, then `CLAUDE_CODE_PROMPT_CACHE_TTL`, the `promptCacheTtl` setting, `ENABLE_PROMPT_CACHING_1H`, then one hour on a subscription and five minutes with `ANTHROPIC_API_KEY` or a cloud provider. A subscription that has run into usage credits drops to five minutes, which a mod cannot see: set the `cacheTtl` option to `5m` then (`claude plugin configure model-fit@my-mods`). A new session's size is taken as the smallest context seen this session. On a subscription plan the dollars are notional, but the same tokens count against your usage limits. `/fit reset` forgets the history and the shadow log.

The advice is a suggestion for the next ask like it: model-fit never switches the model, mid-turn or otherwise. The band gives way while the app shows a survey there, and comes back when the survey closes.

### Jev shadow labels (opt in)

```
claude plugin configure model-fit@my-mods
```

Set `jevShadow` to `on`, and `typesafeApiKey` (or `TYPESAFE_API_KEY`). Set it back to `off` to stop. Each typed ask then also goes to Jev, with the same text Haiku sees: the ask and the end of the last reply.

- **Haiku still drives the advice.** Jev's label is only logged beside it, with Jev's probabilities, how long it took, any error, the turn's model and cost, and Jev's estimated cost ($0.042 per million input tokens, four characters to a token).
- **An unsure Jev is no call.** If Jev's top label is under 80%, it counts as unsure, not as complex and not as a disagreement.
- **Failures are quiet.** Jev gets 8 seconds. A failure or timeout is logged; the first in a session raises one toast, and the Haiku labels carry on.
- `/fit` shows the comparison: asks compared, agreements among Jev's sure answers, how often Jev was unsure or failed, its median time, its total cost, and the last five disagreements. The last 200 asks are kept.

How to read it: neither model is ground truth. Read the disagreements, and spot-check some agreements too: two models can agree and both be wrong. The deciding evidence is the turn itself: how many steps it took and whether a smaller model would have done the job. Replace Haiku with Jev only after enough of your own asks, and only if the disagreements tend to go Jev's way. These mods make no claim about savings: the figures behind posts about routing with Jev are modelled, not measured, and your mix of asks decides what you would save.

Limits: the log holds the first 4,000 characters of each ask in the mod's store on this machine. The costs are list-price estimates. Prompts sent by other plugins, task notifications and continuations are neither judged nor logged.

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

[HANDOFF.md](HANDOFF.md) holds the layout of a mod, the current state and open questions; [API-LESSONS.md](API-LESSONS.md) holds the mod API lessons; [docs/](docs) holds the hindsight plan.
