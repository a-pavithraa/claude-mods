# model-fit

It is a mod rather than a hook because its advice is for you, not the model: a hook's output goes into Claude's context, costs tokens and can steer the answer, while the band and its buttons reach you directly and keep the session's cache and cost state between asks.

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

## Jev shadow labels (opt in)

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
