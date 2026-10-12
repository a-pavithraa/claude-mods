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
