import type { TurnTally } from '../types'

const SIZE_LEVELS = [150, 400, 1000]
const FILES_NAMED = 12

export const sizeLevel = (lines: number) => SIZE_LEVELS.filter(level => lines >= level).length

export const sizeNote = (lines: number, files: number) =>
  `Uncommitted change is now ${lines} lines in ${files} ${files === 1 ? 'file' : 'files'}. Commit a slice, or run /gate to see the risk.`

const GUIDE = `Give me a reading guide for the changes you made in your last turn. Do not change any files.

1. The behaviour that changed, in one sentence.
2. The entry point and the call path from it, each step as file:line.
3. The two or three files I should read closely, and which of the rest are mechanical.
4. The invariants the new code relies on.
5. What you deliberately left untouched, and why.`

export const emptyTally = (): TurnTally => ({ lines: 0, files: [] })

const lineCount = (text: string) => (text === '' ? 0 : text.split(/\r?\n/).length)

export const addWrite = (held: TurnTally, path: string, text: string): TurnTally => ({
  lines: held.lines + lineCount(text),
  files: held.files.includes(path) ? held.files : [...held.files, path],
})

export function guidePrompt(files: string[]): string {
  if (files.length === 0) {
    return GUIDE
  }

  const named = files.slice(0, FILES_NAMED).join('\n')
  const more = files.length > FILES_NAMED ? `\nand ${files.length - FILES_NAMED} more` : ''

  return `${GUIDE}\n\nThe files you changed:\n${named}${more}`
}
