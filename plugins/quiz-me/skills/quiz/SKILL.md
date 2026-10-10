---
name: quiz
description: Quiz the user on the code changes made in this session, three questions, one at a time, to check they understand what changed before they merge it.
disable-model-invocation: true
---

# Quiz on this session's changes

The user wants to check that they understand what this session changed. You ask, they answer from memory, you judge against the code.

## 1. Find the change

The change is what this session edited: the files you wrote or edited in this conversation, plus `git diff HEAD` for anything a shell command changed. If the user names a commit, branch or files, quiz on that instead.

If nothing changed, say so in one line and stop.

## 2. Write three questions, privately

Write exactly three questions. Do not show them yet, and never show an answer before the user has answered.

- Each asks the user to predict what the code now does in one concrete situation: "What happens when ...?"
- Prefer edge cases, refusals and failure paths over the happy path.
- A question must be answerable only by someone who understands the change, never by reading a file name.
- Spread them across the change; no two about the same function.

Before asking, open the code that decides each answer and confirm it. An answer you have not checked against the current file is a guess; replace the question.

## 3. Ask one at a time

Ask question 1 alone, numbered `1/3`, then stop and wait. No hints, no options to pick from: the user answers in their own words.

## 4. Judge each answer

When the user answers:

- Give a verdict: **right**, **partly** or **missed**. "Don't know", "skip" or an empty answer counts as missed.
- Say what was wrong or missing in their answer, if anything, in one sentence.
- Give the real answer in two sentences at most, naming the function and `file:line` that decide it.

Then ask the next question. Do not argue a verdict; if the user disputes one, reread the code and correct yourself if they are right.

## 5. Score

After the third answer, give the score (`2/3`, counting partly as half) and:

- All right: one line saying they understand this change.
- Otherwise: list the `file:line` to reread for each question they missed or got partly, and suggest rereading them before merging.

Do not change any code during the quiz.
