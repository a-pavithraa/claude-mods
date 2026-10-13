import { expect, test } from 'claude-code/testing'

import type { ChangedFile, Flag } from '../types'
import { blastOf, countUsers, startWith, usersQuery } from './blast'

const changed = (path: string, added: number): ChangedFile => ({ path, added, removed: 0, isNew: false })

test('Start with puts code before its tests and names Jev\'s signals by label only', async () => {
  // #given a big test file, two code files, and two Jev flags on usage.ts
  const blast = blastOf([
    changed('plugins/gate/hooks/register.test.ts', 300),
    changed('plugins/gate/hooks/jev.ts', 80),
    changed('plugins/belt/hooks/usage.ts', 40),
    changed('src/__tests__/pager.ts', 200),
  ])
  const at = { path: 'plugins/belt/hooks/usage.ts' }
  const flags: Flag[] = [
    { key: 'data', label: 'stored data', said: 'may touch stored data', isLikely: false, at },
    { key: 'publicApi', label: 'public interface', said: 'likely touches public interface', isLikely: true, at },
  ]

  // #when
  const listed = startWith(blast, flags).map(({ file, why }) => `${file.path}: ${why}`)

  // #then
  expect(listed).toEqual([
    'plugins/belt/hooks/usage.ts: Jev: stored data, public interface',
    'plugins/gate/hooks/jev.ts: one of the biggest changes',
    'plugins/gate/hooks/register.test.ts: tests for the change',
    'src/__tests__/pager.ts: tests for the change',
  ])
})

const finds = (path: string, line: string) => {
  const pattern = usersQuery(path)?.at(-1)

  return pattern === undefined ? undefined : new RegExp(pattern).test(line)
}

test('a TypeScript file is used where a path imports it, not wherever its name is a word', async () => {
  // #given
  const lines = [
    "import { paneOf } from './pane'",
    "export { paneOf } from '../hooks/pane.tsx'",
    "const view = require(\"./ui/pane.js\")",
    "on('ui.render', { component: 'Pane', requestId: PANE })",
    "const pane = await mountPane($, 'terminal')",
    "import { panel } from './panel'",
    "const kind = 'pane'",
  ]

  // #when
  const found = lines.map(line => finds('plugins/triage-gate/hooks/pane.tsx', line))

  // #then
  expect(found).toEqual([true, true, true, false, false, false, false])
})

test('a relative import counts only when it resolves to the file, so a same-named file elsewhere is not its user', async () => {
  // #given grep lines for `pane`, from two plugins that each have a pane.tsx, and a config naming it
  const grepped = [
    "plugins/gate/hooks/register.tsx:import { paneOf } from './pane'",
    "plugins/gate/hooks/register.tsx:import type { PaneView } from './pane.tsx'",
    "plugins/gate/ui/view.tsx:import { paneOf } from '../hooks/pane'",
    "plugins/belt/hooks/register.tsx:import { paneOf } from './pane'",
    'plugins/belt/hooks/hooks.json:  "module": "./pane.tsx"',
    "plugins/gate/hooks/pane.tsx:export { x } from './pane'",
    "src/app.tsx:import { paneOf } from '@gate/hooks/pane'",
  ].join('\n')

  // #when
  const used = countUsers(grepped, 'plugins/gate/hooks/pane.tsx')

  // #then counted: gate's register.tsx once, view.tsx, and the alias import taken on trust
  expect(used).toBe(3)
})

test('a dotted module name keeps its dots when an import resolves to it', async () => {
  // #given
  const grepped = [
    "src/app.ts:import { charge } from './billing.service'",
    "src/api/routes.ts:import { charge } from '@/billing.service.ts'",
    "src/other.ts:import { charge } from './billing'",
  ].join('\n')

  // #when
  const used = countUsers(grepped, 'src/billing.service.ts')

  // #then
  expect(used).toBe(2)
})

test('Python, C, Rust and Ruby files are found through their own import forms', async () => {
  // #given
  const cases: [string, string, boolean][] = [
    ['app/billing.py', 'from app.billing import charge', true],
    ['app/billing.py', 'from app import billing, users', true],
    ['app/billing.py', 'import billing', true],
    ['app/billing.py', 'billing_total = 3', false],
    ['src/pager.h', '#include "util/pager.h"', true],
    ['src/pager.c', '#include <pager.h>', true],
    ['src/pager.c', 'int pager = 0;', false],
    ['src/pager.rs', 'mod pager;', true],
    ['src/pager.rs', 'use crate::ui::pager::Pager;', true],
    ['src/pager.rs', 'let pager = Pager::new();', false],
    ['lib/pager.rb', "require_relative '../lib/pager'", true],
    ['lib/pager.rb', 'pager = Pager.new', false],
  ]

  // #when
  const wrong = cases.filter(([path, line, expected]) => finds(path, line) !== expected)

  // #then
  expect(wrong).toEqual([])
})

test('a class-named file still matches its name as a word; a Go file and an index file are not searched', async () => {
  // #when
  const queries = [
    usersQuery('src/main/java/app/OrderService.java'),
    usersQuery('internal/pager/pager.go'),
    usersQuery('plugins/gate/types/index.d.ts'),
  ]

  // #then
  expect(queries).toEqual([['-w', '-F', '-e', 'OrderService'], undefined, undefined])
})
