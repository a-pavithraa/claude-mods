# Mods handoff (2026-10-10)

What this is: three Claude Code mods (function-hook plugins) and one skill plugin, built to fight comprehension debt and model cost, published as the local marketplace `my-mods`. None of this is part of build-compass; it moved out of `D:\project-map-agent\mods` into this repo on 2026-10-10.

## The plugins

| Plugin | What it does | Tests | Verified live? |
|---|---|---|---|
| `triage-gate` | Gates `git commit` on blast radius plus Jev judgements (Jev is TypeSafe's judging API): holds, flags for reading, or passes. Also `/gate [approve\|codex]` and a pane. Three triggers: before a commit (can hold), on request (`/gate`), and at turn end a local-only size alert when the uncommitted change passes 150, 400 or 1,000 lines (one toast per level, no Jev call). `/guide` puts a reading-guide request for the turn's files in the prompt box, after any draft already there; "Send to Claude" does the same. A line under the verdict says what it rests on: local checks only (no key, or Jev failed), a partial diff, or the whole diff with Jev. A plain commit is judged on what is staged; `commit -a` or a commit naming paths on tracked changes; a command that also runs `git add` on the whole working tree. The commit is found by parsing the command (`hooks/shell.ts`, adapted from prismantis, MIT), so `cd`, `git -C`, `bash -c` and heredoc bodies are handled. The Codex review streams (`$.process.spawn`): the pane shows elapsed time and Codex's latest line, then findings as a list with a "Send to Claude" button, and marks the review stale once Claude edits a file (Edit or Write) or a later triage sees a different change; an edit by hand or through Bash is not seen until the next triage. A failed or timed-out run says so in the pane and in `/gate codex`'s reply, and a review run before any triage still shows. The 10-minute timeout now fires even when Codex prints nothing. A change to sensitive paths (auth, session, token, secret, password, permission, policy, crypto, `.env`) is never a pass, and Jev judging security likely (≥0.7) holds the commit whatever its size. Since 0.7.0 the Codex file list puts flagged files first (auth, secrets, config and similar paths, the risky build or schema files, the most-used file), then the largest, and a pass reads "NO REVIEW TRIGGER" in a neutral colour instead of a green PASS | 36 | Partly: the old 0.1.0 copy made a real Jev call and held, and a Codex run finished (2026-10-10). The request shape matches the TypeSafe API docs. Not seen live in 0.6.0: the streamed review, the size alert, `/guide`, the staged-only scope |
| `model-fit` | Advice for the next ask, never a switch mid-turn (0.4.0). After a simple ask ran on Sonnet, Opus or Fable, the band prices the turn's real token use on Haiku and, if Haiku is 25% cheaper or more, says so with a "Put /model haiku in prompt" button (only into an empty box); a simple ask at high effort that Haiku would not save on gets "lower the effort". A complex ask on Haiku or at low effort gets a warning while it runs: "if the answer looks thin, run it again on Opus". All $ are labelled list-price estimates. Context alerts at 100k/200k/400k/700k tokens stay (band only; after an idle hour it adds what the next action costs). Haiku labels each typed prompt together with the end of the last reply, so "yes please" is judged by the plan it approves; a label that comes back after its turn ended still counts. A turn over 3x its label's typical steps gets no advice and is counted as a wrong label, shown in `/fit`. Also `/fit [reset]` | 14 | Partly: band seen in terminal (0.2.0); 0.4.0 not seen live |
| `quiz-me` | A skill, not a mod, since 0.2.0: `/quiz-me:quiz` asks one to three "what happens when…" questions (by the size of the change) on what the session changed, one at a time; you answer in your own words and it judges against the code. It leaves out uncommitted work from before the session, claims no more than "every situation right", reports where the code does not do what was asked, and gives no merge verdict (0.3.0). The 0.1.0 mod (pane, Show answer buttons, `$.model.fork`) is in the first commit | n/a | No: 0.2.0 not run yet |
| `hindsight` | Watches the main loop for three snags: 10+ Grep/Glob/Read before the first edit of a turn (area = most common folder, 3 deep), a command that fails, gets an edit, and fails again (area = its first plain words), and a tool output over 20k characters. Snags are kept per repo in the store; when one comes back in a 2nd session, one `$.model.fork` (at most 2 per session) proposes a fix and its kind. A one-row band after the turn: a pointer gets Save (marked section of ./CLAUDE.md, 15 lines max; status `done`), any other kind gets "Put task in prompt" (status `sent`: handed over, not known to be done); Skip means "not now": the snag counts sessions from zero and can be proposed again; a `done` or `sent` snag that comes back in a later session reopens as "back after a fix", and the fork is told which fixes did not hold (0.2.0); also "Not in this repo" (mutes that snag) and Skip. `/hindsight` lists the repo's snags and fills the prompt box with `/mattpocock-skills:retro` plus them. Named so it does not clash with the retro skill. Plan: `docs/hindsight-plan.packed.html` | 10 | No: installed 2026-10-10, not run live |

`map-reader` was dropped on 2026-10-10: its pane mostly repeated the project map, and marking files read had no consequence. Only its big-turn toast and `/guide` were kept, in `triage-gate`.

Each mod: `plugins/<mod>/` with `.claude-plugin/plugin.json`, `hooks/hooks.json`, `hooks/register.tsx` and helpers, `hooks/*.test.ts`, `types/index.d.ts`.
Check with `claude plugin validate plugins/<mod>` and `claude plugin test plugins/<mod>`, and `claude plugin validate .` for the marketplace.

## Where things live

- **Source:** this repo, `D:\claude-mods`. `.claude-plugin/marketplace.json` makes it the marketplace `my-mods`; `~/.claude/settings.json` (`extraKnownMarketplaces`) and `~/.claude/plugins/known_marketplaces.json` point at it.
- **What runs:** a directory marketplace is read in place (`claude plugin list` shows "Read from: D:\claude-mods\plugins\<mod>"), so an edit here takes effect at the next session start or `/reload-plugins`. A version bump plus `claude plugin marketplace update my-mods` and `claude plugin update <mod>@my-mods` is only needed to record a new version.
- **Gone (2026-10-10):** `~/.claude/mods` and `D:\project-map-agent\mods`, both identical to this repo's first commit.
- **Dev folder:** `C:\Users\Pavithra\.claude\dev-mods\e1376fad-a1c1-453c-b3f9-42f459bd8f71\<mod>` still has older copies, including the dropped map-reader and turn-pulse. Nothing loads it. Delete it once those two are surely not wanted back.
- **Plugin cache leftovers:** `~/.claude/plugins/cache/my-mods/` still holds install-time copies; directory installs no longer read them.

## Open decisions (start here)

1. **A remote for this repo** and a CI job running validate and test for each plugin. Neither exists yet.

## Still to do

- **triage-gate key:** set the Jev key yourself. Never paste it into chat or put it in the settings.json `env` block.
  ```
  claude plugin configure triage-gate@my-mods
  ```
  The key option is secret, so it never shows in `/config`. The mod falls back to the `TYPESAFE_API_KEY` env var.
- **triage-gate live test:** make a real commit with the key set, try `/gate codex`, and check the pane on desktop.
- **model-fit:**
  - The prices in `hooks/fit.ts` were set on 2026-10-10 from the claude-api skill's table: Haiku 5.5 $0.10/$0.50 (5x that for prompts over 100k), Sonnet 5.5 $2/$10, Opus 5.5 $4/$20, Fable 5.1 $10/$50; cache reads $0.20 (Sonnet, Opus) and $0.25 (Fable). Haiku's cache-read rate (0.1x input) and the 2x one-hour cache-write rate are assumptions. Older Opus and Sonnet versions are priced as the current ones.
  - The Haiku price in the advice assumes Haiku would have taken the same steps and tokens; the band says so. It is a lower bound on what Haiku would cost.
  - The 0.3.x mid-turn switch and subagent hand-off were removed in 0.4.0: a simple turn was usually over before the button could be pressed.
  - Your `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=50` means that on 200k windows, compaction lands at about the same point as the first context alert.
- **Not verified live:** triage-gate 0.7.0's streamed review, timeout, coverage line, box tables, size alert and `/guide`; the quiz-me 0.3.0 skill; model-fit 0.4.0 (above all that the advice shows after a simple turn and that `/model haiku` lands in the prompt box); all of hindsight. For hindsight, confirm live that a Bash call with a non-zero exit comes back with `isError` (the fix-loop signal relies on it), and see how the fork's proposals read.
- **Reviews of the mods** (2026-10-10, kept outside the repo). Done from them: triage-gate 0.7.0, hindsight 0.2.0, quiz-me 0.3.0, model-fit 0.4.0. Left for after live use: a short failure signature per hindsight snag (so two different `npm test` failures are not one snag), and per-repo review rules for triage-gate (a file of paths that always hold) if the built-in sensitive-path guess is noisy.
- **turn-pulse was dropped** on 2026-10-10: the user could not tell what it was for, and the app already shows tool calls and notifies when a turn ends. A copy remains in the dev folder.
- **triage-gate sends code out.** With a key set, every commit Claude makes posts up to 60k characters of the diff to api.typesafe.ai. Any error in the gate lets the commit through.
- **Codex review is prompted (0.5.0).** It runs `codex exec review -` with instructions on stdin: review only the 15 largest changed files from the last triage, the triage's reasons, an optional focus (`/gate codex <focus>`), at most 5 findings in a fixed shape. Since 0.6.0 it also carries the intent: the user's last three prompts in their own words, and a six-line summary of what was built that Claude writes through `$.model.fork` (one extra Claude request per review). The pane shows that summary. `--uncommitted` cannot be combined with a prompt (Codex refuses it). Each run is billed to the user's Codex account; it only runs on request. The `codexModel` option picks a cheaper model. Whether Codex prints its progress on stderr while it works, which the running box relies on, is not confirmed.
- **prismantis** (github.com/NahumLitvin/prismantis) is a display mod: it restyles replies and condenses tool rows. Its shell parser was reused, and the Triage pane's blast-radius and Jev tables follow its box-table look, built from fixed-width cells because the desktop pane's font is not monospace. Not installed.
- **slice-guard is retired.** A copy remains in the dev folder and the plugin cache; delete them.
- **quiz-me became a skill** (2026-10-10): it used no hooks, only `/quiz` and a pane, so it did not need to be a mod. It stays its own plugin so it stays opt-in.

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
