# Mods handoff (2026-10-12)

Four Claude Code mods (function-hook plugins) and one skill plugin, published as the local marketplace `my-mods`. What each does for a user is in [README.md](README.md); mod API lessons are in [API-LESSONS.md](API-LESSONS.md). This file holds state, decisions and open work.

## Next action

Check model-fit 0.7.0 in a live session: run `/reload-plugins`, grow a conversation past 100k tokens, press both new buttons, then run `/model-fit:baton`. Done when the band shows the new lines, each button fills the prompt box, and the baton note opens with a Next action.

## State

| Plugin | Version | Tests | Verified live? |
|---|---|---|---|
| `triage-gate` | 0.9.0 | 80 | Partly: 0.1.0 made a real Jev call and held, and a Codex run finished (2026-10-10); 0.9.0's "which hunk" questions checked against the live API on this repo's diff (2026-10-13) |
| `model-fit` | 0.8.1 | 40 | Partly: band seen in terminal (0.2.0) |
| `hindsight` | 0.4.0 | 31 | Partly: 0.2.0 recorded snags, proposed a fix and handed off to the retro (2026-10-12) |
| `toolbelt` | 0.3.0 | 51 | No: tests, tsc and validate only; `/reload-plugins` then `/unused` not yet run live (see docs/toolbelt-rework-plan.md section 9) |
| `quiz-me` (skill) | 0.3.0 | n/a | No |

- **Committed (2026-10-12):** model-fit 0.8.0 (`c4cd55c`), triage-gate 0.8.3 (`97060e5`), hindsight 0.4.0 (`35af341`); what each version changed is in its commit message.
- **Gate follow-up (0.8.4, uncommitted):** approving a hold says "Approved. Ask Claude to run the commit again."; a stale assessment offers Refresh assessment instead of Approve. Approving (pane or `/gate approve`) re-fingerprints the change first and refuses when it moved on; the pane approves only the assessment it drew. The fingerprint is now the paths and blobs the commit would take (`git diff --raw` plus `hash-object`), so an approval carries over from the tree with new files to the same change staged. To verify live: approve in the pane, then let Claude commit; approve, stage with `git add -A`, then a plain commit.
- **Signals with a where (0.9.0, uncommitted):** `hooks/hunks.ts` tags each hunk of the patch Jev reads (`H01| @@ ...`, diff order, at most 254) with its file and first changed line. The request adds a choice over the tags per risk signal and for readability; `placeOf` sums weight per file (named at ≥0.4) and gives the top hunk's line when it holds more than half the file's share. One `flagsOf` drives the points, the Why lines, Start with (Jev-pointed files rank second, after sensitive paths) and the pane. Behaviour alone is never a flag; it fires only with no tests. "Mixes changes" names the groups (`groupsOf`: first two folders, narrowed). Percentages left the pane and the reasons; `/gate details` keeps them. Diagnostics show the input tokens from Jev's `usage`.
- **Why hunks and these thresholds (live API, 2026-10-13):** TypeSafe bills input only ($0.042/Mtok, output free), so no cap on candidates is needed; size order was dropped because Jev leans to the first option. On the toolbelt-only diff (14.9k tokens) stored data, concurrency and public interface each landed on the right line (`register.tsx:48`, `:220`, `usage.ts:116`). On the whole 19-file tree, answers spread: a "no single hunk" option drew most weight even for likely signals (removed), a "prefer code over docs" nudge spread them more (removed), and "changes behaviour" points at `README.md:56`. Tuned on two diffs only.
- **Fan-in by import (0.9.0):** `usersQuery` greps import forms per language instead of the file stem as a word, and `countUsers` resolves relative TS/JS specs against the importer (`git grep --full-name`). On this repo's diff: `pane.tsx` 15→1, `review.ts` 13→3, `verdict.ts` 12→4, each matching a hand check of `from './x'`. Python, C, Rust and Ruby matches are counted unresolved.
- **Approve fills the commit (0.9.0):** a hold stores Claude's commit command on the triage (`command`); approving in the pane or with `/gate approve` puts "Run the commit again, unchanged" plus that command in the prompt box (appended to a draft), like Send to Claude. A fill, not a submit: `$.prompt.submit` from `command.run` is refused, and pressing Enter keeps the person in charge.
- **Assumed, to verify live:**
  - triage-gate 0.9.0: that the pane's Approve fills the prompt box (only the test engine has seen it); the folded pane on a real commit; whether 0.4 names too much or too little over more diffs; that behaviour pointing at docs stays rare on focused changes.
  - triage-gate: a real commit with the key set; the 0.8.0 pane on desktop and narrow terminals; the streamed Codex review, timeout and size alert; `/guide`; whether Codex prints progress on stderr (the running box relies on it).
  - model-fit: the verdict line; that the advice shows after a simple turn and `/model haiku` lands in the prompt box; Jev shadow against the real API (the `score` probability keys are assumed "0".."2"); whether the detected cache lifetime matches `claude -p "hello" --output-format json` (`usage.cache_creation`); that `turn.step` reports full model ids so the 5.5 effort rule matches; whether a desktop survey is why the 2+2 advice vanished (`claude --debug`); 0.7.0: that `/model-fit:baton` is found without a `skills` entry in the manifest, and how the three context buttons wrap in a narrow terminal.
  - hindsight 0.4.0: that a call declined at the dialog never reaches `tool.call` (the refusal signal relies on it; the test kit's `$.tool.check` carries no `tool_use_id`, so only the pure logic is tested); that the 60s timing excludes the time a dialog is open; the held count over real sessions. 0.3.0: the size re-check and the sizes in the proposal; that a Bash call with a non-zero exit comes back with `isError` (the fix-loop signal relies on it), and how the proposals read.
  - quiz-me 0.3.0.

## Decisions

Open:

1. **A remote for this repo** and a CI job running validate and test for each plugin. Neither exists yet.

Made, with the reasons the README leaves out:

- **triage-gate:** the commit is found by parsing the shell command (`hooks/shell.ts`, adapted from prismantis, MIT), so `cd`, `git -C`, `bash -c` and heredocs are handled. A plain commit is judged on what is staged; `commit -a` or named paths on tracked changes; a command that also runs `git add` on what was staged plus the added paths (`-A` or no paths: the whole tree; `-u`: tracked changes; `-p`, `-i`, `-e`, `--pathspec-from-file`, or an add from another folder: the whole tree). Staged files are passed as `:/<path>` so a commit run from a subfolder still finds them. The points total drives the verdict but is never shown; points are capped per kind (size 3, reach 2, Jev risk 2, Jev quality 2; hold at 5), so Jev topic noise alone cannot hold a small change. Jev security ≥0.7 holds whatever the size. Any error in the gate lets the commit through. The pane lives in `hooks/pane.tsx` as a pure view; `register.tsx` reads state and passes data and callbacks in.
- **triage-gate Codex review:** `codex exec review -` with instructions on stdin: the flagged files then the largest (15 at most), the triage's reasons, an optional focus, at most 5 findings in a fixed shape, the user's last three prompts, and a six-line brief Claude writes through `$.model.fork` (one extra request per review). `--uncommitted` cannot be combined with a prompt. Streams through `$.process.spawn`; the 10-minute timeout fires even when Codex prints nothing.
- **model-fit:** prices in `hooks/fit.ts` come from platform.claude.com/docs/en/about-claude/pricing (2026-10-12); older Opus and Sonnet versions are priced as current ones. Cache lifetime and the effort-keeps-cache rule follow code.claude.com/docs/en/prompt-caching; `/model` cannot set effort, so effort advice uses `/effort <level>`. Each label maps to a model and effort (trivial Haiku/low, normal Sonnet/medium, complex Opus/high) from Claude Code's "choosing a level" guidance. No published output-per-effort figures, so an effort change is never priced. The Haiku price assumes the same steps and tokens, so it is a lower bound. The band yields while `AbovePrompt.hasSurvey` is true. 0.4.0 removed the mid-turn switch: a simple turn was usually over before the button could be pressed.
- **model-fit baton:** the handoff skill ships in model-fit so the command the band names is always installed. It is user-invoked, so it costs no context until typed. Rejected: editing mattpocock's `handoff` (the plugin cache is overwritten on update) and a mod command (a writing rule belongs in a skill). Cache warming was rejected too: a ping adds turns to the history it protects, and pays only if you return within about 20 pings.
- **hindsight:** a snag's area is a path relative to the repo, with hash and UUID folders as `*` so it recurs across installs: the file searched twice or more, else the folder all searches share; for a read, the file; for shell output, each program and its first target (`cat HANDOFF.md, ls plugins`); for a fix loop, the command's first plain words. A read followed by an edit of the same file in the turn is not a snag. A big-read snag is re-checked with `$.fs.stat` before the fork, and reset if the file is now under 20k bytes. Each snag keeps its last 5 calls (one per session) with their cost as evidence for the fork and `/hindsight`. Slow calls are timed with `$.clock.now()` around `next(e)` on Bash and PowerShell (60s). A refusal is a `tool.check` that answered `ask` on the main loop whose `tool_use_id` never reached `tool.call` by the turn's end. A fix is held after 5 sessions in the repo start without the snag (counted at `session.start`). Interrupted turns and corrections were left out on purpose: their fix is usually the prompt or the code, which the retro does not cover. At most 2 `$.model.fork` proposals per session; the Save section of `./CLAUDE.md` is capped at 15 lines. Plan: `docs/hindsight-plan.packed.html`.
- **quiz-me** is a skill since 0.2.0: it used no hooks. The 0.1.0 mod is in the first commit.
- **Dropped 2026-10-10:** map-reader (its toast and `/guide` live on in triage-gate), turn-pulse, slice-guard.

## Gotchas

- Before you test an edit: a directory marketplace is read in place, so an edit takes effect at the next session start or `/reload-plugins`. A version bump plus `claude plugin marketplace update my-mods` and `claude plugin update <mod>@my-mods` only records a new version.
- Before you set the triage-gate key: set it with `claude plugin configure triage-gate@my-mods`, never in chat or the settings.json `env` block. It falls back to `TYPESAFE_API_KEY`. With a key, every commit Claude makes posts up to 60k characters of diff to api.typesafe.ai.
- `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=50` puts compaction on 200k windows at about the first model-fit context alert.

## Pointers

- Each mod: `plugins/<mod>/` with `.claude-plugin/plugin.json`, `hooks/hooks.json`, `hooks/register.tsx` and helpers, `hooks/*.test.ts`, `types/index.d.ts`. A skill plugin has `skills/<name>/SKILL.md`.
- Checks: `claude plugin validate plugins/<mod>`, `claude plugin test plugins/<mod>`, and `claude plugin validate .` for the marketplace.
- `.claude-plugin/marketplace.json` makes this repo the marketplace `my-mods`; `~/.claude/settings.json` (`extraKnownMarketplaces`) and `~/.claude/plugins/known_marketplaces.json` point at it.
- [API-LESSONS.md](API-LESSONS.md): finding things in the mod API reference, what the validator enforces, runtime behaviour.
- To delete: `~/.claude/dev-mods/e1376fad-a1c1-453c-b3f9-42f459bd8f71/` (old copies, incl. map-reader, turn-pulse, slice-guard; nothing loads it) and the install-time copies in `~/.claude/plugins/cache/my-mods/`.

## Later

- **After live use:** a short failure signature per hindsight snag (so two different `npm test` failures are not one snag); per-repo always-hold paths for triage-gate if the sensitive-path guess is noisy.
- **Not started:** hindsight recovery hints; focused tests for triage-gate (candidates through code relationships, optionally ranked by Jev, full suite still required); notes selection (only if large optional notes load needlessly).
