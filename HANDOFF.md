# Mods handoff (2026-10-10)

What this is: three Claude Code mods (function-hook plugins) built in one session to fight comprehension debt and model cost. None of this is part of the build-compass plugin. Nothing here is committed.

## The mods

| Mod | What it does | Tests | Verified live? |
|---|---|---|---|
| `triage-gate` | Gates `git commit` on blast radius plus Jev judgements (Jev is TypeSafe's judging API): holds, flags for reading, or passes. Also `/gate [approve\|codex]` and a pane. Three triggers: before a commit (can hold), on request (`/gate`), and at turn end a local-only size alert when the uncommitted change passes 150, 400 or 1,000 lines (one toast per level, no Jev call). `/guide` puts a reading-guide request for the turn's files in the prompt box. A plain commit is judged on what is staged; `commit -a` or a commit naming paths on tracked changes; a command that also runs `git add` on the whole working tree. The commit is found by parsing the command (`hooks/shell.ts`, adapted from prismantis, MIT), so `cd`, `git -C`, `bash -c` and heredoc bodies are handled. The Codex review streams (`$.process.spawn`): the pane shows elapsed time and Codex's latest line, then findings as a list with a "Send to Claude" button, and marks the review stale once the change is edited | 29 | Partly: the old 0.1.0 copy made a real Jev call and held, and a Codex run finished (2026-10-10). The request shape matches the TypeSafe API docs. Not seen live in 0.6.0: the streamed review, the size alert, `/guide`, the staged-only scope |
| `quiz-me` | `/quiz`: three "what happens when…" questions on what the session changed | 3 | Yes: terminal (2026-10-10) |
| `model-fit` | Band: "simple task on Opus, Haiku would do", or "complex task on Haiku", with token and $ estimates, a one-turn model/effort switch, and context alerts at 100k/200k/400k/700k tokens, in plain words (band only, no toast; after an idle hour (the 1-hour cache these sessions use) it adds what the next action costs; a cold first turn is priced at the cache-write rate). Also `/fit [reset]` | 10 | Yes: band seen in terminal |

`map-reader` was dropped on 2026-10-10: its pane mostly repeated the project map, and marking files read had no consequence. Only its big-turn toast and `/guide` were kept, in `triage-gate`. An inert copy is still in the dev folder if it is ever wanted back.

Each mod: `.claude-plugin/plugin.json`, `hooks/hooks.json`, `hooks/register.tsx` and helpers, `hooks/*.test.ts`, `types/index.d.ts`.
Check with `claude plugin validate <dir>` and `claude plugin test <dir>`. The repo's `npm test` does not run these.

## Where the copies live (they can drift)

- **Repo:** `D:\project-map-agent\mods\<mod>` (this folder) has all three.
- **Dev folder:** `C:\Users\Pavithra\.claude\dev-mods\e1376fad-a1c1-453c-b3f9-42f459bd8f71\<mod>` has older copies, map-reader included. Only that old session hot-reloaded it, so a new session won't load it.
- **Marketplace source:** `C:\Users\Pavithra\.claude\mods\` is the local marketplace `my-mods` (`.claude-plugin/marketplace.json`). It lists triage-gate, quiz-me and model-fit; all three are installed and enabled.
- **Installed (what actually runs):** `C:\Users\Pavithra\.claude\plugins\cache\my-mods\<mod>\<version>`, a copy made at install time. After changing a mod: bump its version, copy it to `~/.claude/mods`, then run `claude plugin marketplace update my-mods` and `claude plugin update <mod>@my-mods`. As of 2026-10-10 all three installed copies match the repo: triage-gate 0.6.0, model-fit 0.2.0, quiz-me 0.1.0.

## Open decisions (start here)

1. **One home per mod.** Proposal: the repo `mods/` is the source, and `~/.claude/mods` becomes a marketplace pointing at it (or the repo gets a `.claude-plugin/marketplace.json`). Then remove the dev-folder copies. (The `CLAUDE_CODE_PLUGIN_DIRS` entry is already gone.)
2. **Which mods to keep installed.** Add them to `my-mods` and run `claude plugin install <mod>@my-mods`.
3. **Commit `mods/` or not**, and whether it belongs in this repo at all, since it isn't part of build-compass.

## Still to do

- **triage-gate key:** set the Jev key yourself. Never paste it into chat or put it in the settings.json `env` block.
  ```
  claude plugin marketplace add C:\Users\Pavithra\.claude\mods   # already done if my-mods shows in settings
  claude plugin install triage-gate@my-mods
  claude plugin configure triage-gate@my-mods                     # if install didn't ask for the key
  ```
  The key option is secret, so it never shows in `/config`. The mod falls back to the `TYPESAFE_API_KEY` env var.
- **triage-gate live test:** make a real commit with the key set, try `/gate codex`, and check the pane on desktop.
- **model-fit:**
  - The prices in `hooks/fit.ts` were set on 2026-10-10 from the claude-api skill's table: Haiku 5.5 $0.10/$0.50 (5x that for prompts over 100k), Sonnet 5.5 $2/$10, Opus 5.5 $4/$20, Fable 5.1 $10/$50; cache reads $0.20 (Sonnet, Opus) and $0.25 (Fable). Haiku's cache-read rate (0.1x input) and the 2x one-hour cache-write rate are assumptions. Older Opus and Sonnet versions are priced as the current ones.
  - The threshold is a guess: switch only if it saves ≥25%. At these prices Haiku wins for any simple ask under 100k of context, so the "cache makes staying nearly as cheap" note no longer appears.
  - A simple turn is usually over before the switch button can be pressed, so the Haiku offer mostly teaches "start small asks on Haiku". Open question: drop the button for simple asks and keep it for "complex on Haiku".
  - The first request of a turn goes out before classification, so a switch applies from request 2 on.
  - Your `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=50` means that on 200k windows, compaction lands at about the same point as the first context alert.
- **Not verified live:** triage-gate 0.6.0's streamed review, box tables, size alert and `/guide`.
- **turn-pulse was dropped** on 2026-10-10 (uninstalled, out of `my-mods`, folders deleted): the user could not tell what it was for, and the app already shows tool calls and notifies when a turn ends. A copy remains in the dev folder.
- **triage-gate sends code out.** With a key set, every commit Claude makes posts up to 60k characters of the diff to api.typesafe.ai. Any error in the gate lets the commit through.
- **Codex review is prompted (0.5.0).** It runs `codex exec review -` with instructions on stdin: review only the 15 largest changed files from the last triage, the triage's reasons, an optional focus (`/gate codex <focus>`), at most 5 findings in a fixed shape. Since 0.6.0 it also carries the intent: the user's last three prompts in their own words, and a six-line summary of what was built that Claude writes through `$.model.fork` (one extra Claude request per review). The pane shows that summary. `--uncommitted` cannot be combined with a prompt (Codex refuses it). Each run is billed to the user's Codex account; it only runs on request. The `codexModel` option picks a cheaper model. Whether Codex prints its progress on stderr while it works, which the running box relies on, is not confirmed.
- **prismantis** (github.com/NahumLitvin/prismantis) is a display mod: it restyles replies and condenses tool rows. Its shell parser was reused, and the Triage pane's blast-radius and Jev tables follow its box-table look, built from fixed-width cells because the desktop pane's font is not monospace. Its tool-row summary overlaps turn-pulse's tally; not installed.
- **slice-guard is retired.** Its folders in the repo and `~/.claude/mods` were deleted on 2026-10-10; a copy remains in the dev folder and the plugin cache; delete them.
- **quiz-me stays its own mod** (decided 2026-10-10): it works live and is opt-in, so whoever wants `/quiz` installs it. Don't merge it into another mod.
- **Unrelated:** `CHANGELOG.md` has 2 blank lines added at the end. They weren't made in this session, so they were left alone.

## API lessons (save re-learning)

- Mock answers in tests are `{ value: ... }`. A plugin's deny comes back as `result.deny`. `command.run` needs `origin` and `presentation`.
- `$.clock.after` needs `mock.clock(on)`. Advance it with `clock.settle()` or `clock.advance(ms)`.
- `$.ui.mount` of a band whose hook calls `next(e)` needs a bottom hook: `on('ui.render', () => ({ type: 'engine', ref: 0 }))`. Return a tree there instead (`{ type: 'Text', children: ['…'] }`) to stand in for another plugin's band. Of two `ui.render` mocks, the first registered answers.
- The band above the prompt is one instance: a hook that returns without `next` hides every plugin below it. `next(e)` resolves to `{ type: 'engine' }` when nothing below drew.
- `$.ui.status` is drawn by the engine as `⚠ <plugin>: <text>`; it can't be restyled. The `Spinner` render's `suffix` prop is a friendlier place for live turn info.
- Only pass `$` to top-level functions, or validate fails. `$.prompt.submit` from `command.run` is refused; use `$.prompt.fill`.
- `turn.step` hooks must be async generators: `return yield* next({ ...e, model })` rewrites the model for that request.
- `session.measure` pushes context tokens after each turn. `$.model.classify(text, labels, { model: 'haiku' })` is the cheap classifier.
- On Windows, start Codex through `cmd.exe /d /c codex …`; a bare spawn fails with ENOENT.
- Type-check a mod with `npx -p typescript@5.6.3 tsc -p <mod>`. The engine writes `.claude-plugin/types/` when it loads the mod; before that, copy them from another mod.
- The API reference is `claude-code.d.ts` from the `plugin-authoring` skill. Load the skill and grep the file it names.
