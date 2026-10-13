# triage-gate

It is a mod rather than a skill because it has to intercept the commit, and its pane, live Codex progress and approval buttons are the workflow.

Before a commit Claude makes, it scores the change and gives one of three verdicts:

- **No review trigger**: nothing fired. This is not a claim that the change is safe.
- **Review recommended**: the commit goes through, with a toast saying why to read it.
- **Hold: review before commit**: the commit is refused until you approve it.

The verdict comes from the blast radius (lines, files, areas, how many files use the changed one, build and schema files) and, with a TypeSafe key, from Jev's judgements (security, data, money, concurrency, public API, readability). Consequence is judged apart from size: a change to sensitive paths (auth, session, token, secret, permission, `.env` and similar) is never a pass, and a likely security change is held whatever its size.

"Used by" counts the files that import the changed one: a quoted path in TypeScript or JavaScript (a relative one must resolve to the file, so a `./pane` next to another `pane.tsx` does not count), `import`/`from` in Python, `#include` in C and C++, `mod`/`use` in Rust, `require` in Ruby. C#, Java, Kotlin, Scala, Swift and PHP files match the class name as a word. Go files and generic names (`index`, `utils`, `types` ...) are not counted.

The Triage pane leads with the verdict and what it means, a one-line summary of the change (files, lines added and removed, areas), and what the assessment rests on: the whole diff with Jev, part of it, or local checks only, with the reason Jev was not used. Then come **Why**, the concrete reasons, and **Start with**, up to five files to inspect first, each with its reason (sensitive code, a file Jev points at with its signals by name, build or schema, widely used, biggest change), code before its tests at each step. If the change is edited after the assessment, the pane says it is stale, hides **Approve commit** and makes **Refresh assessment** the main button. **Detailed signals** is folded by default and shows only the Jev signals that fired, each as likely or possible with what it measures and where to look: the file and line Jev picks, or for a mixed change the groups it could be split into. A behaviour change counts only when no tests in the diff cover it, since nearly every diff changes behaviour. What Jev checked and did not flag fits on one line, then a diagnostics line (who judged, how long Jev took, how many tokens it read, when it ran). Percentages are left to `/gate details`. The API key is never shown.

Jev picks the place in the same request. Each hunk of the diff Jev reads is tagged `H01|`, `H02|` ... and each risk signal and readability gets a choice among the tags, in diff order (Jev leans toward the first option, so size or risk order would bias it). A file is named when its hunks hold at least 0.4 of the weight together, and the line of its top hunk when that hunk holds more than half of the file's share. A one-hunk change needs no question. TypeSafe bills input only ($0.042 per million tokens); the tags and questions added about 3k tokens to an 18.8k-token diff, so a commit costs about a tenth of a cent. On a focused diff the places were exact; on a wide, mixed one Jev mostly names none, and the mixed-change flag is the useful line there.

Commands (each works without the pane):

- `/gate` triages the uncommitted change and opens the Triage pane. The pane's **Refresh assessment** does the same.
- `/gate details` prints the pane's content as text: reasons, files to start with, every Jev signal with its percentage and file, and diagnostics.
- `/gate approve` (or the pane's **Approve commit**) approves the last triaged change and puts the request to commit in the prompt box, after anything already typed there; press Enter to send it. When the hold came from Claude's commit, the request repeats that exact command; after a plain `/gate`, it asks Claude to commit the change. It first checks the change against the assessment: if anything was edited since, it approves nothing, marks the assessment stale and asks you to run `/gate` again. The pane approves only the assessment it is showing. An approval covers the same files with the same content however the commit is made, so approving the working tree with new files still holds once those files are staged.
- `/gate codex [focus]` (or the pane's **Run Codex review**) runs a Codex review of at most 15 changed files: flagged ones first, then the largest. Findings show in the pane with a "Send to Claude" button. The review is marked stale when Claude edits a file with Edit or Write, or a later triage sees a different change. Edits by hand, by shell commands or by other tools are not noticed: run `/gate` after them.
- `/guide` puts a reading-guide request for the turn's files in the prompt box.

At the end of a turn it also raises a toast when the uncommitted change grows past a size level, once per level.

Setup:

```
claude plugin configure triage-gate@my-mods
```

The `typesafeApiKey` option is secret; `TYPESAFE_API_KEY` is the fallback. Without either, triage uses the blast radius alone. `codexModel` picks the Codex review model.

Note: with a key configured, each triage (a commit Claude makes, `/gate`, or "Triage again") sends the changed file paths and up to 60k characters of the diff to TypeSafe (api.typesafe.ai). A Codex review runs only on request and is billed to your Codex account.
