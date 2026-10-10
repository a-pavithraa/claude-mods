import type { Question } from '../types'

export const QUESTION_COUNT = 3

export const QUIZ_PROMPT = `Write exactly ${QUESTION_COUNT} questions that test whether I understand the code changes made in this session.

Each question asks me to predict what the code now does in one concrete situation ("What happens when ...?"). Prefer edge cases, refusals and failure paths over the happy path. A question must be answerable only by someone who understands the change, never by reading a file name.

Each answer is two sentences at most and names the function and file that decide it.

Reply with a JSON array and nothing else: [{"ask": "...", "answer": "..."}]`

const isPair = (value: unknown): value is { ask: string; answer: string } =>
  typeof value === 'object' &&
  value !== null &&
  'ask' in value &&
  'answer' in value &&
  typeof value.ask === 'string' &&
  typeof value.answer === 'string'

export function parseQuestions(reply: string): Question[] {
  const from = reply.indexOf('[')
  const to = reply.lastIndexOf(']')

  if (from < 0 || to < from) {
    return []
  }

  let parsed: unknown

  try {
    parsed = JSON.parse(reply.slice(from, to + 1))
  } catch {
    return []
  }

  return Array.isArray(parsed)
    ? parsed
        .filter(isPair)
        .slice(0, QUESTION_COUNT)
        .map(({ ask, answer }) => ({ ask, answer, isShown: false }))
    : []
}

export function scoreOf(questions: Question[]) {
  const judged = questions.filter(question => question.knew !== undefined)

  return {
    isComplete: questions.length > 0 && judged.length === questions.length,
    knew: judged.filter(question => question.knew === true).length,
    of: questions.length,
  }
}
