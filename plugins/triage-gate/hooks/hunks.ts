import type { Place } from '../types'

/** A Choice takes at most 255 options; one is kept for "none of these". */
export const MOST_HUNKS = 254

const FILE_HEADER = /^diff --git "?a\/.+"? "?b\/(.+?)"?$/
const NEW_FILE = /^\+\+\+ new file (.+)$/
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/

export type Hunk = Place & { id: string; line: number }

const idOf = (at: number) => `H${String(at + 1).padStart(2, '0')}`

/**
 * The patch with each hunk tagged `H01| `, `H02| ` ... at its header, in diff order, and where each one is: its file
 * and the first changed line on the new side. A new file sent whole is one hunk at line 1. Hunks past `MOST_HUNKS`
 * stay untagged.
 */
export function tagHunks(patch: string): { tagged: string; hunks: Hunk[] } {
  const hunks: Hunk[] = []
  let path: string | undefined
  let line = 0
  let open: Hunk | undefined

  const tagged = patch.split('\n').map(text => {
    const file = FILE_HEADER.exec(text)?.[1] ?? NEW_FILE.exec(text)?.[1]

    if (file !== undefined) {
      path = file
      open = undefined

      if (!text.startsWith('+++ new file ') || hunks.length >= MOST_HUNKS) {
        return text
      }

      hunks.push({ id: idOf(hunks.length), path, line: 1 })

      return `${idOf(hunks.length - 1)}| ${text}`
    }

    const header = HUNK_HEADER.exec(text)

    if (header !== null && path !== undefined) {
      line = Number(header[1])

      if (hunks.length >= MOST_HUNKS) {
        open = undefined

        return text
      }

      open = { id: idOf(hunks.length), path, line }
      hunks.push(open)

      return `${open.id}| ${text}`
    }

    if (open !== undefined && (text.startsWith('+') || text.startsWith('-'))) {
      open.line = line
      open = undefined
    }

    if (text.startsWith(' ') || text.startsWith('+')) {
      line += 1
    }

    return text
  })

  return { tagged: tagged.join('\n'), hunks }
}
