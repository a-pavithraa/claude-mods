# toolbelt

It is a mod rather than a script because it reads what the session actually loaded: the skills and MCP tools Claude Code lists at runtime, with whether each server connected and whether its tools are deferred. Config files alone do not show that.

Lists the plugins, skills and MCP servers nobody used in 14 days, dearest first, so you can disable or remove them. Change the window with `claude plugin configure toolbelt@my-mods` (7, 14, 30, 60 or 90 days). It does not judge whether a skill is good; it counts use.

Plugins and skills are judged by the usage counters Claude Code keeps in `~/.claude.json` (the ones `/skill-doctor` reads), so the list agrees with Claude Code and `/unused` answers at once; nothing is read from transcripts. Those counters are internal: if they cannot be read the pane says skills are not judged. Nothing there counts MCP use, so Toolbelt counts server calls itself from the first session and lists a server only once that tracking is as old as the window. A server's scope (user, project, local) is read from `.mcp.json` and the same config, and a project or local server is unused per repo.

A plugin is one row, because its skills can only be switched off together; it is listed only if none of its skills was used. Above those, **Loaded twice** lists a plugin installed from two marketplaces (the copy updated longest ago is the one offered for Disable or Uninstall) and a user skill that a plugin also carries (Disable moves your copy aside); these are listed whether or not they are used. A toast says how many are unused and what they cost per turn, at most once a day and only when the list changed. `/unused` opens the pane:

- A plugin: **Disable** runs `claude plugin disable` on its `name@marketplace` id (all its skills go; it stays installed). **Uninstall…** asks again. `anthropic-skills`, which the desktop app syncs from your account, offers Disable only.
- A user skill: **Disable** moves its folder to `~/.claude/skills-disabled`; **Enable** moves it back.
- An MCP server: the CLI has no disable, so the button is **Remove** (`claude mcp remove`), which also deletes its env and keys.
- Each row has a mark and a bar for how many tokens it adds to every prompt; the dearest stand out. The list is paged, 8 to a page. A terminal narrower than 110 columns cannot seat the pane, so `/unused` shows the top 15 as a notice instead.
- A server Toolbelt can't remove (a claude.ai connector, one a plugin or an app added) is still listed when unused, with where to switch it off and only **Keep**. A server your config names that gave the session no tools is listed as not connected, used or not, unless you switched it off for the repo; it is left out of the toast, since servers may still be connecting at startup.
- **Keep** mutes an item for good.

Every action asks a second time and takes effect in the next session. Actions run the `claude` CLI; no config file is edited by hand.
