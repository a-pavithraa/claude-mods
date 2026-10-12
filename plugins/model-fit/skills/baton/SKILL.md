---
name: baton
description: Write a handoff note so a fresh session can pick up this task, then give the line that starts it.
argument-hint: "[what the next session is for] [path to write to]"
disable-model-invocation: true
---

# Pass the baton

The next runner is a fresh session with none of this conversation. It reads the baton once and starts running. Write for that reader: it knows the repo's tools and nothing of what was said here.

## 1. Gather

Collect from this conversation, then check each fact against the repo (git status, the files, a test run when cheap):

- the goal and the next action
- what is verified, what is assumed, what is broken
- each decision and its reason, with the options rejected
- gotchas: a quirk that cost time, a trap the next step walks into
- the skills the next session should invoke, by their exact names in the skill list

Done when every fact has a source: you saw it in the repo, or the user said it.

## 2. Write

Use this layout. Leave out a section that has nothing in it.

```markdown
# Baton: <task> (<date time>)

## Next action
<One imperative sentence.> Done when <observable result>.

## State
- Verified: <fact> (<how you know>)
- Assumed: <fact> (<why you think so>)
- Broken: <what fails, the error, where>

## Decisions
- <decision>: <reason>. Rejected: <option>, because <reason>.

## Gotchas
- Before <step>: <the trap and the way around it>.

## Pointers
- <path, command, URL or commit>: <what the next session finds there>

## Skills
- `<skill name>`: <the step it serves>
```

Write in the plain style of ASD-STE100, without its dictionary:

- One instruction per sentence, in the imperative. An instruction has 20 words at most; a description has 25.
- Active voice, simple present or past tense.
- One term for one thing: the same name in every section, and the name the code uses.
- Noun clusters of three words at most.
- A warning goes before the step it applies to.
- Code names, paths and commands stay exact, in backticks.

Point to what the repo already holds: commits, diffs, specs, plans, the file tree. Copy into the baton only what no file holds: reasons, rejected options, traps, open questions.

Keep secrets out: keys, passwords, tokens, personal data.

When the user describes the next session, aim every section at that work.

## 3. Save and hand over

Save to the path the user gave. Without one, save to the OS temp directory (`$TMPDIR`, else `/tmp`; `%TEMP%` on Windows) as `baton-<repo>-<yyyymmdd-hhmm>.md`. Write a new file each time.

Reply with the path and this line for the user to paste after `/clear`:

> Read `<path>` and treat it as the state of the work. Start with its Next action. Check a fact in the repo only when the next step depends on it.
