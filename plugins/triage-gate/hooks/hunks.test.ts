import { expect, test } from 'claude-code/testing'

import { MOST_HUNKS, tagHunks } from './hunks'

test('each hunk is tagged at its header and placed at its first changed line, not its first context line', async () => {
  // #given
  const patch = [
    'diff --git a/src/pager.ts b/src/pager.ts',
    '--- a/src/pager.ts',
    '+++ b/src/pager.ts',
    '@@ -10,6 +10,7 @@ export function pageCount(items: Item[]) {',
    ' const size = 10',
    ' const pages = []',
    '-return items.length / size',
    '+return Math.ceil(items.length / size)',
    'diff --git a/src/list.ts b/src/list.ts',
    '@@ -1,2 +1,3 @@',
    '+import { pageCount } from "./pager"',
  ].join('\n')

  // #when
  const { tagged, hunks } = tagHunks(patch)

  // #then
  expect([hunks, tagged.split('\n')[3], tagged.split('\n')[9]]).toEqual([
    [
      { id: 'H01', path: 'src/pager.ts', line: 12 },
      { id: 'H02', path: 'src/list.ts', line: 1 },
    ],
    'H01| @@ -10,6 +10,7 @@ export function pageCount(items: Item[]) {',
    'H02| @@ -1,2 +1,3 @@',
  ])
})

test('a new file sent whole is one hunk at line 1, and a quoted path loses its quotes', async () => {
  // #given
  const patch = ['diff --git "a/my notes.md" "b/my notes.md"', '@@ -0,0 +1 @@', '+hi', '+++ new file docs/plan.md', 'step one'].join('\n')

  // #when
  const { hunks } = tagHunks(patch)

  // #then
  expect(hunks.map(({ path, line }) => `${path}:${line}`)).toEqual(['my notes.md:1', 'docs/plan.md:1'])
})

test('hunks past the Choice limit stay untagged', async () => {
  // #given
  const patch = [
    'diff --git a/a.ts b/a.ts',
    ...Array.from({ length: MOST_HUNKS + 3 }, (_, at) => `@@ -${at + 1} +${at + 1} @@\n+x`),
  ].join('\n')

  // #when
  const { tagged, hunks } = tagHunks(patch)

  // #then
  expect([hunks.length, tagged.split('\n').filter(line => /^H\d+\| /.test(line)).length]).toEqual([MOST_HUNKS, MOST_HUNKS])
})
