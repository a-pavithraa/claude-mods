# Mods handoff (2026-10-14)

Three Claude Code mods (function-hook plugins) and one skill plugin, published as the local marketplace `my-mods`. What each does for a user is in [README.md](README.md); mod API lessons are in [API-LESSONS.md](API-LESSONS.md). This file holds state, decisions and open work.

## Next action

Check model-fit 0.7.0 in a live session: run `/reload-plugins`, grow a conversation past 100k tokens, press both new buttons, then run `/model-fit:baton`. Done when the band shows the new lines, each button fills the prompt box, and the baton note opens with a Next action.

## State

| Plugin | Version | Tests | Verified live? |
|---|---|---|---|
| `model-fit` | 0.8.2 | 42 | Partly: band seen in terminal (0.2.0); Jev `score` keys "0".."2" confirmed live on 1.13 and 1.14 (2026-10-16) |
| `hindsight` | 0.4.1 | 33 | Partly: 0.2.0 recorded snags, proposed a fix and handed off to the retro (2026-10-12) |
| `toolbelt` | 0.3.0 | 51 | No: tests, tsc and validate only; `/reload-plugins` then `/unused` not yet run live (see docs/toolbelt-rework-plan.md section 9) |
| `quiz-me` (skill) | 0.3.0 | n/a | No |

- **triage-gate moved (2026-11-27)** to its own repository, github.com/a-pavithraa/triage-gate, with its history; its state and decisions are in that repository's HANDOFF.md.
- **Committed (2026-10-12):** model-fit 0.8.0 (`c4cd55c`), hindsight 0.4.0 (`35af341`); what each version changed is in its commit message.
- **Jev pinned (model-fit 0.8.2):** model-fit and triage-gate asked `jev-latest`, which TypeSafe moves to `jev-1.14.0` around 2026-10-21. A `jevModel` option (`jev-1.13.0` default, `jev-1.14.0`, `jev-latest`) now picks the model. Live on 2026-10-16, four commits of this repo (2645e5d, 008310e, 84d2ac5, 0389b39), 1.14 against 1.13: no signal crossed a threshold (0.3/0.4/0.7) and no verdict changed; scores moved by at most 0.13 (security on 008310e, 0.15 to 0.28, still under 0.3); the "which hunk" answers kept the same files, but 1.14 dropped the line on concurrency (`register.tsx:220` to the file) and pointed money at `README.md:1`. Latency similar (270-550ms). 1.14's images, `box` type and long context were left out: no text use, and TypeSafe calls them not production-ready. Switch the default to 1.14 after more diffs, before TypeSafe retires 1.13 (60 days' notice).
- **Assumed, to verify live:**
  - model-fit: the verdict line; that the advice shows after a simple turn and `/model haiku` lands in the prompt box; Jev shadow inside a live session; whether the detected cache lifetime matches `claude -p "hello" --output-format json` (`usage.cache_creation`); that `turn.step` reports full model ids so the 5.5 effort rule matches; whether a desktop survey is why the 2+2 advice vanished (`claude --debug`); 0.7.0: that `/model-fit:baton` is found without a `skills` entry in the manifest, and how the three context buttons wrap in a narrow terminal.
  - hindsight 0.4.0: that a call declined at the dialog never reaches `tool.call` (the refusal signal relies on it; the test kit's `$.tool.check` carries no `tool_use_id`, so only the pure logic is tested); that the 60s timing excludes the time a dialog is open; the held count over real sessions. 0.3.0: the size re-check and the sizes in the proposal; that a Bash call with a non-zero exit comes back with `isError` (the fix-loop signal relies on it), and how the proposals read.
  - quiz-me 0.3.0.
- **toolbelt 2645e5d, open findings (visual review trial, 2026-10-14; possible, not confirmed, tests not run):**
  - `usage.ts:134`: `installsOf` reads only `entries[0]` of each id's installs, so a project-scoped install for another repo counts as live, and a plugin from two marketplaces shows as loaded twice in every repo. Fix: read every entry and keep user scope plus this repo's project scope only. This machine's install record has no such case.
  - `usage.ts:97, 323`: `downUnits` sees only the two disabled lists, so a `.mcp.json` server not yet approved reads as "not connected" and is offered Remove. Fix: read `enabledMcpjsonServers` / `enableAllProjectMcpServers`, or label such servers "not approved".

## Decisions

Open:

1. **A remote for this repo** and a CI job running validate and test for each plugin. Neither exists yet.
2. **A visual code review (2026-10-14).** A review from Opus arrives as a wall of terminal text. Recommended, not started: a thin skill, not a mod. It runs the built-in `/code-review` for findings that are already structured and checked, draws them as one HTML page in visual-explainer's style with a call-stack figure for each finding, and reuses `/visual-explainer:plan-review`'s accept/reject page to send decisions back. About half a day, mostly writing the skill's instructions. Waiting on a go-ahead.
   - **Mod option, set aside:** `/code-review` reports through the `ReportFindings` tool (`file`, `line`, `summary`, `short_summary`, `failure_scenario`, `category`, `verdict`, `outcome`), and `ui.render` can redraw the `ToolUse` component as a findings table with Fix/Skip buttons. It works, but the terminal elements (Box, Text, Code, Markdown) limit the layout. Parsing a free-form review in `AssistantMessage` would break easily. If it is built anyway, it could be a section of triage-gate's pane (now in its own repository).
   - **Tools found (web search, 2026-10-14):** visual-explainer (nicobailon, `/diff-review`), Hiveteq/review-report, explain-diff-html, diffwalk, code-review-graph; CodeRabbit and Greptile are hosted and work on PRs only. Most of them explain a change rather than judge it. None combines checked findings, a call stack per finding and answers sent back from the page.
   - **visual-explainer, tried:** installed from the `visual-explainer-marketplace` marketplace (0.12.0). `/visual-explainer:diff-review 2645e5d` wrote `~/.agent/diagrams/toolbelt-2645e5d-review.html` (verdict, pipeline before/after, file map, small diagrams per case, risk table, checklist). The look is good and nothing from it runs; it is instructions and a style guide only. The findings came from the model reading the diff: the skill does not check them, has no call stack per finding, and has no way to answer findings on the page.
   - **review-report, rejected:** 0 stars, and it runs its own `node render.mjs`, so the user chose not to install it. Auto mode also refused to run it from a scratchpad clone.

Made, with the reasons the README leaves out:

- **model-fit:** prices in `hooks/fit.ts` come from platform.claude.com/docs/en/about-claude/pricing (2026-10-12); older Opus and Sonnet versions are priced as current ones. Cache lifetime and the effort-keeps-cache rule follow code.claude.com/docs/en/prompt-caching; `/model` cannot set effort, so effort advice uses `/effort <level>`. Each label maps to a model and effort (trivial Haiku/low, normal Sonnet/medium, complex Opus/high) from Claude Code's "choosing a level" guidance. No published output-per-effort figures, so an effort change is never priced. The Haiku price assumes the same steps and tokens, so it is a lower bound. The band yields while `AbovePrompt.hasSurvey` is true. 0.4.0 removed the mid-turn switch: a simple turn was usually over before the button could be pressed.
- **model-fit baton:** the handoff skill ships in model-fit so the command the band names is always installed. It is user-invoked, so it costs no context until typed. Rejected: editing mattpocock's `handoff` (the plugin cache is overwritten on update) and a mod command (a writing rule belongs in a skill). Cache warming was rejected too: a ping adds turns to the history it protects, and pays only if you return within about 20 pings.
- **hindsight:** a snag's area is a path relative to the repo, with hash and UUID folders as `*` so it recurs across installs: the file searched twice or more, else the folder all searches share; for a read, the file; for shell output, each program and its first target (`cat HANDOFF.md, ls plugins`); for a fix loop, the command's first plain words. A read followed by an edit of the same file in the turn is not a snag. A big-read snag is re-checked with `$.fs.stat` before the fork, and reset if the file is now under 20k bytes. Each snag keeps its last 5 calls (one per session) with their cost as evidence for the fork and `/hindsight`. Slow calls are timed with `$.clock.now()` around `next(e)` on Bash and PowerShell (60s). A refusal is a `tool.check` that answered `ask` on the main loop whose `tool_use_id` never reached `tool.call` by the turn's end. A fix is held after 5 sessions in the repo start without the snag (counted at `session.start`). Interrupted turns and corrections were left out on purpose: their fix is usually the prompt or the code, which the retro does not cover. At most 2 `$.model.fork` proposals per session; the Save section of `./CLAUDE.md` is capped at 15 lines. Plan: `docs/hindsight-plan.packed.html`.
- **quiz-me** is a skill since 0.2.0: it used no hooks. The 0.1.0 mod is in the first commit.
- **Dropped 2026-10-10:** map-reader (its toast and `/guide` live on in triage-gate), turn-pulse, slice-guard.

## Gotchas

- Before you test an edit: a directory marketplace is read in place, so an edit takes effect at the next session start or `/reload-plugins`. A version bump plus `claude plugin marketplace update my-mods` and `claude plugin update <mod>@my-mods` only records a new version.
- `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=50` puts compaction on 200k windows at about the first model-fit context alert.

## Pointers

- Each mod: `plugins/<mod>/` with `.claude-plugin/plugin.json`, `hooks/hooks.json`, `hooks/register.tsx` and helpers, `hooks/*.test.ts`, `types/index.d.ts`. A skill plugin has `skills/<name>/SKILL.md`.
- Checks: `claude plugin validate plugins/<mod>`, `claude plugin test plugins/<mod>`, and `claude plugin validate .` for the marketplace.
- `.claude-plugin/marketplace.json` makes this repo the marketplace `my-mods`; `~/.claude/settings.json` (`extraKnownMarketplaces`) and `~/.claude/plugins/known_marketplaces.json` point at it.
- [API-LESSONS.md](API-LESSONS.md): finding things in the mod API reference, what the validator enforces, runtime behaviour.
- To delete: `~/.claude/dev-mods/e1376fad-a1c1-453c-b3f9-42f459bd8f71/` (old copies, incl. map-reader, turn-pulse, slice-guard; nothing loads it) and the install-time copies in `~/.claude/plugins/cache/my-mods/`.

## Later

- **After live use:** a short failure signature per hindsight snag (so two different `npm test` failures are not one snag).
- **Not started:** hindsight recovery hints; notes selection (only if large optional notes load needlessly).
