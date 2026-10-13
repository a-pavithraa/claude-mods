# Mod API lessons

What the mod API taught us, to save re-learning. Session state and open work are in [HANDOFF.md](HANDOFF.md).

## Finding things in the reference

The reference is `claude-code.d.ts` (about 800 KB) in the `plugin-authoring` skill, unpacked under `%TEMP%/claude/bundled-skills/<claude version>/<hash>/plugin-authoring/types/`. Never read it whole; grep it:

- An event's input: grep `'<event.name>': ` (e.g. `'ui.render': `), then `export type <Name> =`.
- An engine call: grep `<method>: (` (e.g. `classify: (`, `fork: (`, `spawn: (`).
- Render elements per surface: `export type Elements = {`. The terminal has Box, Text, Button, Input, Select, Link, Code, Markdown.

Known signatures:

- `$.model.classify(text, labels, { model: 'haiku' })` → `Promise<string | undefined>`: the cheap classifier.
- `$.model.fork(request)` → `Promise<ModelForkResult>`; check `isAnswered` before `text`.
- `$.process.spawn({ argv, input })` is a stream: `next()` yields `{ stream, text }` chunks, `result` gives the exit code.
- `$.agent.spawn(AgentSpawnArgs)`: `prompt` plus optional `description`, `subagentType`, `model`, `name`, `cwd`.
- A narrowed render input is `RenderInput<'Pane'>`; its elements are `Elements[RenderInput<'Pane'>['surface']]`.

## What the validator enforces

- `$` may be passed only to top-level functions declared in the same file, never to an imported one. A helper module stays pure; the hooks file reads state and passes data and callbacks in (see triage-gate's `pane.tsx`).
- `read`/`update` need an atom declared in the hooks file itself, not imported.
- `$.prompt.submit` from `command.run` is refused; use `$.prompt.fill`.

## Behaviour

- Mock answers in tests are `{ value: ... }`. A plugin's deny comes back as `result.deny`. `command.run` needs `origin` and `presentation`.
- `$.clock.after` needs `mock.clock(on)`. Advance it with `clock.settle()` or `clock.advance(ms)`.
- `$.ui.mount` of a band whose hook calls `next(e)` needs a bottom hook: `on('ui.render', () => ({ type: 'engine', ref: 0 }))`. Return a tree there instead (`{ type: 'Text', children: ['…'] }`) to stand in for another plugin's band. Of two `ui.render` mocks, the first registered answers.
- The band above the prompt is one instance: a hook that returns without `next` hides every plugin below it. `next(e)` resolves to `{ type: 'engine' }` when nothing below drew.
- `$.ui.status` is drawn by the engine as `⚠ <plugin>: <text>`; it can't be restyled. The `Spinner` render's `suffix` prop is a friendlier place for live turn info.
- `turn.step` hooks must be async generators: `return yield* next({ ...e, model })` rewrites the model for that request.
- `session.measure` pushes context tokens after each turn.
- On Windows, start Codex through `cmd.exe /d /c codex …`; a bare spawn fails with ENOENT.
- Type-check a mod with `npx -p typescript@5.6.3 tsc -p <mod>`. The engine writes `.claude-plugin/types/` when it loads the mod; before that, copy them from another mod.
- prismantis (github.com/NahumLitvin/prismantis), a display mod, is the source of triage-gate's shell parser. Not installed.

## toolbelt, checked against 2.1.296
- `$.fs.read` rejects any file over 4 MiB, which hid 15 of 114 transcripts. `~/.claude.json` (134 KB) is read with `${home}/.claude.json`, the same way the old code read `${home}/.claude/projects/...`. **A1** is exercised by the mock world only; confirm it in a live `/unused`.
- Claude Code's own counters: `skillUsage` (`{ usageCount, lastUsedAt }` per skill, qualified and bare names mixed), `mcpServers` (user scope), `projects[path].mcpServers` (local scope). Nothing counts MCP use. Ignore `pluginUsage`: stale entries, and hook-only plugins read 0 with a fresh time. All internal and undocumented.
- **A2** (a mod's own command arrives with `source: 'plugin'` and a bare name; a plugin's skill is `<plugin>:<skill>`), **A3** (`skillUsage` is written when the skill runs) and **A4** (`.mcp.json` is `{ "mcpServers": { ... } }`) are not verified live. The code relies on A2 to keep `unused`, `gate` and `fit` off the list: if a mod command shows up, find another tell.
- `claude plugin disable|enable|uninstall` wants `name@marketplace`; ids are the keys of `plugins` in `~/.claude/plugins/installed_plugins.json`. A bare name is refused for a plugin no settings file names yet, and is ambiguous when two marketplaces install the same name (superpowers here).
- `anthropic-skills` is not in the install record: the desktop app syncs it to `~/.claude/skills/synced/`. `claude plugin disable anthropic-skills@inline` succeeds but writes `"anthropic-skills@synced": false` to `enabledPlugins`, and `enable …@inline` then writes `@inline: true` without undoing it. Use `anthropic-skills@synced` for both. **Not verified:** that `enable …@synced` works, and that the disable holds in the next session.
- Seen live: `$.command.list()` reports a synced `anthropic-skills` skill as `{ name: 'docx', source: 'user' }` with no `plugin`, and as `anthropic-skills:skill-creator` only when a user skill has the bare name. The tell is its folder under `~/.claude/skills/synced/<account>/`. The model's own skill list shows the same skills as `anthropic-skills:docx`.
- `claude mcp get <name>` connects to the server, so it costs seconds per server; scope comes from data now.
- `$.store.delete(key)` exists. The test engine has no `$.store`: for a store assertion, answer `store.get`, `store.set`, `store.delete` and `store.keys` from a Map in the test world instead of `mock.store`.
- A mod has no `tsconfig.json`. To type-check, point one at `claude-code.d.ts` from the `plugin-authoring` skill (no `jsxImportSource`) and include `register.tsx` and `register.test.ts`.
