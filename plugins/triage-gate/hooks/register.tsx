import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register, RenderChildren } from 'claude-code'

import type { ChangedFile, Jev, Review, Scope, Triage, Verdict } from '../types'
import { blastOf, countUsers, lineCount, parseNumstat, stemOf } from './blast'
import { addWrite, emptyTally, guidePrompt, sizeLevel, sizeNote } from './guide'
import { JEV_URL, PATCH_CHARS, parseJev, requestBody } from './jev'
import {
  BRIEF_CHARS,
  BRIEF_PROMPT,
  addAsk,
  fixPrompt,
  lastLine,
  parseReview,
  reviewPrompt,
  reviewScope,
  tookOf,
} from './review'
import { commitIn } from './shell'
import { verdictOf } from './verdict'

const PANE = 'triage-gate'
const TITLE = 'Triage'
const UNTRACKED_READ = 30
const UNTRACKED_CHARS = 4000
const FAN_IN_FILES = 15
const REVIEW_CHARS = 20_000
const REVIEW_TIMEOUT_MS = 600_000
const BAR_CELLS = 10
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const GOOD_WHEN_HIGH = new Set(['tested'])

const triage = atom({ plugin: 'triage-gate', key: 'triage' } as const, null)
const approved = atom({ plugin: 'triage-gate', key: 'approved' } as const, [])
const review = atom({ plugin: 'triage-gate', key: 'review' } as const, { status: 'idle' })
const turn = atom({ plugin: 'triage-gate', key: 'turn' } as const, emptyTally())
const sizeSeen = atom({ plugin: 'triage-gate', key: 'sizeLevel' } as const, 0)
const asks = atom({ plugin: 'triage-gate', key: 'asks' } as const, [])

const BADGE: Record<Verdict, { mark: string; word: string; tone: 'success' | 'warning' | 'error' }> = {
  pass: { mark: '●', word: 'PASS', tone: 'success' },
  read: { mark: '◐', word: 'READ IT', tone: 'warning' },
  hold: { mark: '■', word: 'HOLD FOR REVIEW', tone: 'error' },
}

type Where = { cwd?: string; stdin?: string }

async function git($: EngineInterface, args: string[], where: Where = {}) {
  const ran = await $.process.run(['git', ...args], where).catch(() => undefined)

  return ran?.exitCode === 0 ? ran.stdout : undefined
}

const inside = (cwd: string | undefined) => (cwd === undefined ? {} : { cwd })

async function hexOf(text: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))

  return [...new Uint8Array(digest)]
    .slice(0, 8)
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
}

async function untrackedFiles($: EngineInterface, cwd?: string) {
  const listed = (await git($, ['ls-files', '--others', '--exclude-standard'], inside(cwd))) ?? ''
  const paths = listed.split(/\r?\n/).filter(Boolean)

  return Promise.all(
    paths.map(async (path, at) => {
      const from = cwd === undefined ? path : `${cwd}/${path}`
      const text = at < UNTRACKED_READ ? await $.fs.read(from).catch(() => '') : ''
      const file: ChangedFile = { path, added: lineCount(text), removed: 0, isNew: true }

      return { file, text }
    }),
  )
}

type Untracked = Awaited<ReturnType<typeof untrackedFiles>>

async function identityOf($: EngineInterface, untracked: Untracked, cwd?: string) {
  if (untracked.length === 0) {
    return ''
  }

  const paths = untracked.map(({ file }) => file.path).join('\n')
  const hashes = await git($, ['hash-object', '--stdin-paths'], { ...inside(cwd), stdin: paths })

  return `${paths}\n${hashes ?? untracked.map(({ text }) => text).join('\n')}`
}

async function usersOf($: EngineInterface, file: ChangedFile, cwd?: string): Promise<ChangedFile> {
  const stem = stemOf(file.path)

  if (stem === undefined || file.isNew) {
    return file
  }

  const found = (await git($, ['grep', '-l', '-w', '-F', '-e', stem], inside(cwd))) ?? ''

  return { ...file, usedBy: countUsers(found, file.path) }
}

async function jevOf($: EngineInterface, key: string | undefined, body: string): Promise<Jev> {
  if (key === undefined || key === '') {
    return { status: 'off' }
  }

  try {
    const answered = await $.http.fetch(JEV_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body,
    })

    return parseJev(answered.status, answered.text)
  } catch {
    return { status: 'failed', note: 'Jev could not be reached; triage used blast radius only.' }
  }
}

async function changedSince($: EngineInterface, scope: Scope, cwd?: string) {
  const first = scope === 'staged' ? '--cached' : 'HEAD'
  const numstat = await git($, ['diff', first, '--numstat'], inside(cwd))

  if (numstat !== undefined || scope === 'staged') {
    return { range: first, numstat }
  }

  return { range: EMPTY_TREE, numstat: await git($, ['diff', EMPTY_TREE, '--numstat'], inside(cwd)) }
}

async function runTriage(
  $: EngineInterface,
  options: PluginOptions,
  scope: Scope = 'tree',
  cwd?: string,
): Promise<Triage | null> {
  const { range, numstat } = await changedSince($, scope, cwd)

  if (numstat === undefined) {
    return null
  }

  const untracked = scope === 'tree' ? await untrackedFiles($, cwd) : []
  const tracked = parseNumstat(numstat)

  if (tracked.length === 0 && untracked.length === 0) {
    await update($, triage, () => null)

    return null
  }

  const diff = (await git($, ['diff', range], inside(cwd))) ?? ''
  const fullPatch = [
    diff,
    ...untracked.map(({ file, text }) => `+++ new file ${file.path}\n${text.slice(0, UNTRACKED_CHARS)}`),
  ].join('\n')
  const patch = fullPatch.slice(0, PATCH_CHARS)
  const files = await Promise.all(
    [...tracked, ...untracked.map(({ file }) => file)].map((file, at) =>
      at < FAN_IN_FILES ? usersOf($, file, cwd) : file,
    ),
  )
  const blast = blastOf(files)
  const configured = options.typesafeApiKey
  const key =
    typeof configured === 'string' && configured !== ''
      ? configured
      : await $.env.get('TYPESAFE_API_KEY')
  const jev = await jevOf($, key, requestBody(blast, patch))
  const judged: Triage = {
    fingerprint: await hexOf(`${diff}\n${await identityOf($, untracked, cwd)}`),
    ...verdictOf(blast, jev),
    blast,
    jev,
    isPatchCut: fullPatch.length > PATCH_CHARS,
  }

  await update($, triage, () => judged)

  return judged
}

async function briefOf($: EngineInterface) {
  const reply = await $.model.fork({ prompt: BRIEF_PROMPT }).catch(() => undefined)

  return reply?.isAnswered === true ? reply.text.trim().slice(0, BRIEF_CHARS) : undefined
}

async function runCodex($: EngineInterface, options: PluginOptions, focus = '') {
  const startedAt = Date.now()
  const judged = await read($, triage)
  const fingerprint = judged?.fingerprint
  const covers = reviewScope(judged, focus).label
  await update($, review, (): Review => ({ status: 'running', covers, tookMs: 0, doing: 'Writing down what was asked for…' }))
  const brief = await briefOf($)
  const told = brief === undefined ? {} : { brief }
  const intent = { asks: await read($, asks), ...told }
  const isWindows = (await $.env.get('OS')) === 'Windows_NT'
  const model = typeof options.codexModel === 'string' && options.codexModel !== '' ? ['-m', options.codexModel] : []
  const codex = ['codex', 'exec', 'review', ...model, '-']
  const said = { stdout: '', stderr: '' }
  let exit: number | null | undefined

  try {
    const child = $.process.spawn({
      argv: isWindows ? ['cmd.exe', '/d', '/c', ...codex] : codex,
      input: reviewPrompt(judged, focus, intent),
    })

    for await (const piece of child) {
      said[piece.stream] += piece.text
      const tookMs = Date.now() - startedAt
      const doing = lastLine(piece.text)
      await update($, review, (held): Review => ({
        status: 'running',
        covers,
        ...told,
        tookMs,
        ...(doing !== undefined ? { doing } : held.status === 'running' && held.doing !== undefined ? { doing: held.doing } : {}),
      }))

      if (tookMs > REVIEW_TIMEOUT_MS) break
    }

    exit = (await child.result.catch(() => ({ code: null }))).code
  } catch {
    exit = undefined
  }

  const text =
    exit === undefined
      ? 'Codex could not be started. Is the codex CLI installed and logged in?'
      : (said.stdout.trim() || said.stderr.trim() || 'Codex printed nothing.').slice(-REVIEW_CHARS)
  const done: Review = {
    status: 'done',
    covers,
    ...told,
    ...parseReview(text),
    tookMs: Date.now() - startedAt,
    isClean: exit === 0,
    ...(fingerprint === undefined ? {} : { fingerprint }),
  }
  await update($, review, () => done)

  return done
}

async function noteSize($: EngineInterface) {
  const { numstat } = await changedSince($, 'tree')

  if (numstat === undefined) {
    return
  }

  const untracked = await untrackedFiles($)
  const blast = blastOf([...parseNumstat(numstat), ...untracked.map(({ file }) => file)])
  const level = sizeLevel(blast.lines)
  const seen = await read($, sizeSeen)

  if (level > seen) {
    $.ui.toast(sizeNote(blast.lines, blast.files.length), { timeoutMs: 12000 })
  }

  if (level !== seen) {
    await update($, sizeSeen, () => level)
  }
}

const summaryOf = (judged: Triage) =>
  `${BADGE[judged.verdict].word} (risk ${judged.points})${judged.reasons.length > 0 ? `: ${judged.reasons.join('; ')}` : ''}`

const openPane = ($: EngineInterface) => $.ui.open({ id: PANE, title: TITLE })

const bar = (value: number) => {
  const filled = Math.round(Math.min(1, Math.max(0, value)) * BAR_CELLS)

  return { filled: '█'.repeat(filled), empty: '░'.repeat(BAR_CELLS - filled) }
}

const toneOf = (risk: number) => (risk >= 0.7 ? 'error' : risk >= 0.4 ? 'warning' : 'success')

async function gate($: EngineInterface, options: PluginOptions, command: string, isPosix: boolean) {
  const commit = commitIn(command, isPosix)

  if (commit === undefined) {
    return undefined
  }

  const judged = await runTriage($, options, commit.scope, commit.cwd)

  if (judged === null || (await read($, approved)).includes(judged.fingerprint)) {
    return undefined
  }

  if (judged.verdict === 'hold') {
    void openPane($)

    return `triage-gate held this commit for human review, ${summaryOf(judged)}. Do not retry the commit or work around this hold. Tell the user: they can read the change, run /gate codex for a Codex review, or run /gate approve to let this exact change through.`
  }

  if (judged.verdict === 'read') {
    $.ui.toast(`Committed, but worth reading: ${judged.reasons.slice(0, 2).join('; ')}. /gate shows why.`, {
      timeoutMs: 10000,
    })
  }

  return undefined
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'gate',
      description: 'Judge the uncommitted change: blast radius, risk and readability',
      argumentHint: '[approve | codex [what to focus on]]',
    })
    await $.command.register({
      name: 'guide',
      description: 'Ask for a reading guide to what the last turn changed',
    })

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'composer') {
      await update($, turn, emptyTally)
      const text = e.text.trim()

      if (text !== '' && !text.startsWith('/')) {
        await update($, asks, held => addAsk(held, text))
      }
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const ran = await next(e)

    if (ran.deny === undefined && ran.isError !== true) {
      await update($, turn, held => addWrite(held, e.file_path, e.new_string))
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const ran = await next(e)

    if (ran.deny === undefined && ran.isError !== true) {
      await update($, turn, held => addWrite(held, e.file_path, e.content))
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)

    if (e.agentId === undefined) {
      await noteSize($)
    }

    return done
  })

  on('command.run', { command: 'guide' }, async $ => {
    const prompt = guidePrompt((await read($, turn)).files)
    const filled = await $.prompt.fill({ text: prompt, mode: 'replace' })

    return {
      text: filled.isFilled
        ? 'The request for a reading guide is in your prompt box. Press Enter to send it.'
        : `Send this to get a reading guide:\n\n${prompt}`,
    }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const held = await gate($, options, e.command, true)

    return held === undefined ? next(e) : { deny: held }
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'PowerShell' }, async ($, e, next) => {
    const held = await gate($, options, e.command, false)

    return held === undefined ? next(e) : { deny: held }
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'gate' }, async ($, e) => {
    const asked = e.args.trim()

    if (asked === 'approve') {
      const judged = await read($, triage)

      if (judged === null) {
        return { text: 'Nothing has been triaged yet. Run /gate first.' }
      }

      await update($, approved, list => [...new Set([...list, judged.fingerprint])])

      return { text: 'Approved. Claude can commit this exact change now; any further edit needs triage again.' }
    }

    if (asked === 'codex' || asked.startsWith('codex ')) {
      void openPane($)
      const done = await runCodex($, options, asked.slice('codex'.length).trim())

      return {
        text:
          done.findings.length > 0
            ? `Codex found ${done.findings.length} ${done.findings.length === 1 ? 'problem' : 'problems'}. See the Triage pane.`
            : 'Codex review finished with no findings listed. See the Triage pane.',
      }
    }

    void openPane($)
    const judged = await runTriage($, options)

    return { text: judged === null ? 'Nothing uncommitted to triage.' : summaryOf(judged) }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const judged = await read($, triage)
    const reviewed = await read($, review)
    const isApproved = judged !== null && (await read($, approved)).includes(judged.fingerprint)

    if (judged === null) {
      return (
        <Box flexDirection="column">
          <Text dimColor wrap="wrap">
            Nothing triaged yet. Triage runs when Claude commits, or type /gate.
          </Text>
        </Box>
      )
    }

    const badge = BADGE[judged.verdict]
    const { blast, jev } = judged
    const ruleCells = e.surface === 'terminal' ? 1 : 2
    const cells = (widths: number[], held: RenderChildren[]) =>
      held.flatMap((one, at) => [
        at > 0 ? <Text dimColor> │ </Text> : null,
        <Box width={widths[at] ?? 0} flexShrink={0} overflow="hidden">
          {one}
        </Box>,
      ])
    const table = (widths: number[], header: string[], rows: RenderChildren[][]) => (
      <Box flexDirection="column" borderStyle="single" borderDimColor paddingX={1} alignSelf="flex-start">
        <Box>{cells(widths, header.map(name => <Text bold>{name}</Text>))}</Box>
        <Box>{cells(widths, widths.map(width => <Text dimColor>{'─'.repeat(width * ruleCells)}</Text>))}</Box>
        {rows.map(row => (
          <Box>{cells(widths, row)}</Box>
        ))}
      </Box>
    )

    return (
      <Box flexDirection="column">
        <Box>
          <Text color={badge.tone} bold>
            {badge.mark} {badge.word}
          </Text>
          <Box flexGrow={1} />
          <Text dimColor>risk {judged.points}</Text>
          {isApproved && <Text color="success"> · approved</Text>}
        </Box>

        <Box marginTop={1}>
          <Text bold color="claude">
            BLAST RADIUS
          </Text>
        </Box>
        {table(
          [8, 8, 8],
          ['files', 'lines', 'areas'],
          [[<Text>{blast.files.length}</Text>, <Text>{blast.lines}</Text>, <Text>{blast.areas.length}</Text>]],
        )}
        {blast.widest !== undefined && (
          <Text dimColor wrap="wrap">
            widest: {blast.widest.path} named by {blast.widest.usedBy} files
          </Text>
        )}
        {blast.risky.length > 0 && (
          <Text color="warning" wrap="wrap">
            ▲ {blast.risky.join(', ')}
          </Text>
        )}

        <Box marginTop={1}>
          <Text bold color="claude">
            JEV
          </Text>
        </Box>
        {jev.status === 'off' && (
          <Text dimColor wrap="wrap">
            Not configured. Set the TypeSafe API key in /config or TYPESAFE_API_KEY.
          </Text>
        )}
        {jev.status === 'failed' && (
          <Text color="warning" wrap="wrap">
            {jev.note}
          </Text>
        )}
        {jev.status === 'judged' &&
          table(
            [18, BAR_CELLS, 5],
            ['signal', 'likelihood', ''],
            [...jev.judgments, { key: 'readability', label: 'hard to read', value: jev.hardToRead }].map(one => {
              const cells = bar(one.value)

              return [
                <Text>{one.label}</Text>,
                <Box>
                  <Text color={toneOf(GOOD_WHEN_HIGH.has(one.key) ? 1 - one.value : one.value)}>{cells.filled}</Text>
                  <Text dimColor>{cells.empty}</Text>
                </Box>,
                <Text>{one.value.toFixed(2)}</Text>,
              ]
            }),
          )}
        {judged.isPatchCut && (
          <Text dimColor>Jev saw the first {PATCH_CHARS / 1000}k characters of the diff.</Text>
        )}

        {judged.reasons.length > 0 && (
          <Box marginTop={1}>
            <Text bold color="claude">
              WHY
            </Text>
          </Box>
        )}
        {judged.reasons.map(reason => (
          <Text wrap="wrap">· {reason}</Text>
        ))}

        <Box marginTop={1} gap={1}>
          <Button key="rerun" label="Triage again" onPress={async () => void (await runTriage($, options))} />
          <Button
            key="codex"
            label={reviewed.status === 'running' ? 'Codex reviewing…' : 'Codex review'}
            onPress={async () => {
              if (reviewed.status !== 'running') {
                await runCodex($, options)
              }
            }}
          />
          {judged.verdict === 'hold' && !isApproved && (
            <Button
              key="approve"
              label="Approve"
              variant="primary"
              onPress={() => update($, approved, list => [...new Set([...list, judged.fingerprint])])}
            />
          )}
        </Box>

        {reviewed.status === 'running' && (
          <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="suggestion" paddingX={1}>
            <Box>
              <Text bold color="suggestion">
                Codex is reviewing…
              </Text>
              <Box flexGrow={1} />
              <Text dimColor>{tookOf(reviewed.tookMs)}</Text>
            </Box>
            <Text dimColor wrap="truncate-end">
              {reviewed.doing ?? 'Starting Codex. A review usually takes a few minutes.'}
            </Text>
            <Text dimColor wrap="wrap">
              Reviewing {reviewed.covers}. This run is billed to your Codex account.
            </Text>
          </Box>
        )}

        {reviewed.status === 'done' && (
          <Box
            flexDirection="column"
            marginTop={1}
            borderStyle="round"
            borderColor={reviewed.findings.length > 0 ? 'warning' : 'subtle'}
            paddingX={1}
          >
            <Box>
              <Text bold color={reviewed.findings.length > 0 ? 'warning' : 'success'}>
                {reviewed.findings.length > 0
                  ? `Codex found ${reviewed.findings.length} ${reviewed.findings.length === 1 ? 'problem' : 'problems'}`
                  : 'Codex review'}
              </Text>
              <Box flexGrow={1} />
              <Text dimColor>{tookOf(reviewed.tookMs)}</Text>
            </Box>
            <Text dimColor wrap="wrap">
              Covered {reviewed.covers}.
            </Text>
            {reviewed.brief !== undefined && (
              <Box flexDirection="column">
                <Text dimColor>Codex was told this is what was built:</Text>
                <Text dimColor wrap="wrap">
                  {reviewed.brief}
                </Text>
              </Box>
            )}
            {reviewed.fingerprint !== judged.fingerprint && (
              <Text color="warning" wrap="wrap">
                ▲ The change has been edited since this review. Run it again.
              </Text>
            )}
            {reviewed.summary !== '' && <Text wrap="wrap">{reviewed.summary}</Text>}
            {reviewed.findings.map(one => (
              <Box flexDirection="column" marginTop={1}>
                <Box>
                  <Text bold color={one.priority === 'P1' ? 'error' : 'warning'}>
                    {one.priority}{' '}
                  </Text>
                  <Box flexShrink={1}>
                    <Text bold wrap="wrap">
                      {one.title}
                    </Text>
                  </Box>
                </Box>
                <Text color="suggestion" wrap="truncate-end">
                  ↳ {one.at}
                </Text>
                <Text dimColor wrap="wrap">
                  {one.body}
                </Text>
              </Box>
            ))}
            {reviewed.findings.length > 0 && (
              <Box marginTop={1}>
                <Button
                  key="fix"
                  label="Send to Claude"
                  variant="primary"
                  onPress={async () => {
                    await $.prompt.fill({ text: fixPrompt(reviewed.findings), mode: 'replace' })
                  }}
                />
              </Box>
            )}
          </Box>
        )}
      </Box>
    )
  })
}
