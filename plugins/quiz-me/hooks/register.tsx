import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Question, Quiz } from '../types'
import { QUIZ_PROMPT, parseQuestions, scoreOf } from './quiz'

const PANE = 'quiz-me'
const TITLE = 'Quiz'

const quiz = atom({ plugin: 'quiz-me', key: 'quiz' } as const, {
  status: 'idle',
  questions: [],
})

const WHY_NOT: Record<string, string> = {
  'nothing-to-fork': 'There is nothing to ask about yet: this session has no turns.',
  'empty-reply': 'The model answered with nothing. Try /quiz again.',
  aborted: 'The quiz was interrupted. Try /quiz again.',
  'api-error': 'The model could not be reached. Try /quiz again.',
}

const setQuiz = ($: EngineInterface, next: Quiz) => update($, quiz, () => next)

async function writeQuiz($: EngineInterface): Promise<string> {
  await setQuiz($, { status: 'asking', questions: [] })
  const reply = await $.model.fork({ prompt: QUIZ_PROMPT })

  if (!reply.isAnswered) {
    const note = WHY_NOT[reply.reason] ?? 'The quiz could not be written.'
    await setQuiz($, { status: 'failed', note, questions: [] })

    return note
  }

  const questions = parseQuestions(reply.text)

  if (questions.length === 0) {
    const note = 'The model did not answer with questions. Try /quiz again.'
    await setQuiz($, { status: 'failed', note, questions: [] })

    return note
  }

  await setQuiz($, { status: 'ready', questions })

  return `${questions.length} questions are ready in the Quiz pane.`
}

const changeQuestion = (
  $: EngineInterface,
  index: number,
  change: (question: Question) => Question,
) =>
  update($, quiz, held => ({
    ...held,
    questions: held.questions.map((question, at) =>
      at === index ? change(question) : question,
    ),
  }))

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'quiz',
      description: 'Three questions on what this session changed',
    })

    return next(e)
  })

  on('command.run', { command: 'quiz' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE, focus: true, closeOnEscape: true })

    return { text: await writeQuiz($) }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const { status, note, questions } = await read($, quiz)
    const score = scoreOf(questions)

    return (
      <Box flexDirection="column">
        <Box>
          <Text color="claude">? </Text>
          <Text bold>Do you understand what changed?</Text>
          <Box flexGrow={1} />
          {status === 'ready' && (
            <Text dimColor>
              {score.knew}/{score.of}
            </Text>
          )}
        </Box>

        {status === 'idle' && (
          <Text dimColor wrap="wrap">
            Type /quiz after Claude has changed something.
          </Text>
        )}
        {status === 'asking' && (
          <Text color="suggestion">Writing three questions about this session…</Text>
        )}
        {status === 'failed' && (
          <Text color="warning" wrap="wrap">
            {note}
          </Text>
        )}

        {questions.map((question, index) => (
          <Box
            flexDirection="column"
            marginTop={1}
            borderStyle="round"
            borderColor={
              question.knew === undefined
                ? 'subtle'
                : question.knew
                  ? 'success'
                  : 'error'
            }
            paddingX={1}
          >
            <Text bold wrap="wrap">
              {index + 1}. {question.ask}
            </Text>
            {!question.isShown && (
              <Box>
                <Text dimColor>Answer it in your head, then </Text>
                <Button
                  key={`show:${index}`}
                  label="Show answer"
                  hotkey={String(index + 1)}
                  onPress={() =>
                    changeQuestion($, index, held => ({ ...held, isShown: true }))
                  }
                />
              </Box>
            )}
            {question.isShown && (
              <Text dimColor wrap="wrap">
                {question.answer}
              </Text>
            )}
            {question.isShown && question.knew === undefined && (
              <Box gap={1}>
                <Button
                  key={`knew:${index}`}
                  label="Knew it"
                  variant="primary"
                  onPress={() =>
                    changeQuestion($, index, held => ({ ...held, knew: true }))
                  }
                />
                <Button
                  key={`missed:${index}`}
                  label="Missed it"
                  onPress={() =>
                    changeQuestion($, index, held => ({ ...held, knew: false }))
                  }
                />
              </Box>
            )}
            {question.knew === true && <Text color="success">✓ You knew it</Text>}
            {question.knew === false && <Text color="error">✗ You missed it</Text>}
          </Box>
        ))}

        {score.isComplete && (
          <Box marginTop={1}>
            <Text
              color={score.knew === score.of ? 'success' : 'warning'}
              wrap="wrap"
            >
              {score.knew === score.of
                ? `${score.knew} of ${score.of}. You understand this change.`
                : `${score.knew} of ${score.of}. Reread what you missed before you merge.`}
            </Text>
          </Box>
        )}
      </Box>
    )
  })
}
