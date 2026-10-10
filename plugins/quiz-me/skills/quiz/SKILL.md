---
name: quiz
description: Quiz the user on the code changes made in this session, one to three questions, one at a time, to check they can predict what the changed code does.
disable-model-invocation: true
---

# Quiz on this session's changes

The user wants to check that they understand what this session changed. You ask, they answer from memory, you judge against the code.

## 1. Find the change

The change is what this session edited: the files you wrote or edited in this conversation, plus files a shell command in this conversation changed. `git diff HEAD` also holds work that was uncommitted before the session started; leave out any hunk this conversation did not make. If the user names a commit, branch or files, quiz on that instead.

If nothing changed, say so in one line and stop.

## 2. Write the questions, privately

Write one question for a small change (one function or a few lines), two for a medium one, three at most. Do not show them yet, and never show an answer before the user has answered.

- Each asks the user to predict what the code now does in one concrete situation: "What happens when ...?"
- Where the change has them, cover the intended behaviour, a failure path, and an invariant the change must keep. Prefer edge cases and refusals over the happy path.
- A question must be answerable only by someone who understands the change, never by reading a file name.
- Spread them across the change; no two about the same function.

Before asking, open the code that decides each answer and confirm it. An answer you have not checked against the current file is a guess; replace the question.

Also note, for each question, what the user asked for in this conversation. If the code does not do what was asked, that is a finding, not a quiz answer: tell the user after they answer.

## 3. Ask one at a time

Ask question 1 alone, numbered `1/N`, then stop and wait. No hints, no options to pick from: the user answers in their own words.

## 4. Judge each answer

When the user answers:

- Give a verdict: **right**, **partly** or **missed**. "Don't know", "skip" or an empty answer counts as missed.
- Say what was wrong or missing in their answer, if anything, in one sentence.
- Give the real answer in two sentences at most, naming the function and `file:line` that decide it.
- If the user predicted what was asked for and the code does something else, say so plainly: their answer is right about the intent, and the code has a bug.

Then ask the next question. Do not argue a verdict; if the user disputes one, reread the code and correct yourself if they are right.

## 5. Score

After the last answer, give the score (`2/3`, counting partly as half) and:

- All right: one line saying they got every situation right. A few answers do not prove they understand the whole change, so do not claim that.
- Otherwise: list the `file:line` to reread for each question they missed or got partly.
- List any place where the code does not do what was asked.

The score is not a merge verdict; do not say whether the change is ready to merge.

Do not change any code during the quiz.
