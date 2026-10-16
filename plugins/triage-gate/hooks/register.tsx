import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { ChangedFile, Jev, Review, Scope, Subject, Triage } from '../types'
import { blastOf, countUsers, lineCount, parseNumstat, parseRaw, usersQuery } from './blast'
import { addWrite, emptyTally, guidePrompt, sizeLevel, sizeNote } from './guide'
import { JEV_MODEL, JEV_URL, PATCH_CHARS, askOf, parseJev } from './jev'
import { paneOf } from './pane'
import { commitPrompt, detailsText, reviewHeadline, subjectKey, summaryOf } from './report'
import { BRIEF_CHARS, BRIEF_PROMPT, addAsk, lastLine, parseReview, reviewPrompt, reviewScope } from './review'
import { commitIn } from './shell'
import { verdictOf } from './verdict'

const PANE = 'triage-gate'
const TITLE = 'Triage'
const UNTRACKED_READ = 30
const UNTRACKED_CHARS = 4000
const FAN_IN_FILES = 15
const REVIEW_CHARS = 20_000
const REVIEW_TIMEOUT_MS = 600_000
const TIMED_OUT = 'timed out'
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

const triage = atom({ plugin: 'triage-gate', key: 'triage' } as const, null)
const approved = atom({ plugin: 'triage-gate', key: 'approved' } as const, [])
const review = atom({ plugin: 'triage-gate', key: 'review' } as const, { status: 'idle' })
const turn = atom({ plugin: 'triage-gate', key: 'turn' } as const, emptyTally())
const sizeSeen = atom({ plugin: 'triage-gate', key: 'sizeLevel' } as const, 0)
const asks = atom({ plugin: 'triage-gate', key: 'asks' } as const, [])
const details = atom({ plugin: 'triage-gate', key: 'details' } as const, false)

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

const pathspec = (paths: string[] | undefined) => (paths === undefined ? [] : ['--', ...paths])

async function untrackedFiles($: EngineInterface, cwd?: string, within?: string[]) {
  const listed = (await git($, ['ls-files', '--others', '--exclude-standard', ...pathspec(within)], inside(cwd))) ?? ''
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

/**
 * The paths and blobs the commit would take, so a change gets one fingerprint however it was judged: as a working
 * tree with new files, or after they were staged. Falls back to the diff text when git cannot hash the files.
 */
async function fingerprintOf($: EngineInterface, range: string, limit: string[], untracked: Untracked, cwd?: string) {
  const raw = await git($, ['diff', range, '--raw', '-z', '--no-abbrev', '--no-renames', ...limit], inside(cwd))
  const [prefix = '', up = ''] = ((await git($, ['rev-parse', '--show-prefix', '--show-cdup'], inside(cwd))) ?? '').split(/\r?\n/)
  const changed = [
    ...parseRaw(raw ?? '').map(({ path, blob }) => ({ path, from: `${up}${path}`, blob })),
    ...untracked.map(({ file }) => ({ path: `${prefix}${file.path}`, from: file.path, blob: undefined })),
  ]
  const unhashed = changed.filter(({ blob }) => blob === undefined).map(({ from }) => from)
  const hashed =
    unhashed.length === 0 ? '' : await git($, ['hash-object', '--stdin-paths'], { ...inside(cwd), stdin: unhashed.join('\n') })

  if (raw === undefined || hashed === undefined) {
    const diff = (await git($, ['diff', range, ...limit], inside(cwd))) ?? ''

    return hexOf([diff, ...untracked.map(({ file, text }) => `${file.path}\n${text}`)].join('\n'))
  }

  const blobs = hashed.split(/\r?\n/)
  let next = 0
  const lines = changed.map(({ path, blob }) => `${path}\t${blob === undefined ? blobs[next++] : (blob ?? '-')}`)

  return hexOf(lines.sort().join('\n'))
}

/** The fingerprint of the change `subject` names as it stands now, without judging it; `undefined` when git failed. */
async function fingerprintNow($: EngineInterface, subject?: Subject) {
  const scope = subject?.scope ?? 'tree'
  const { range, limit, paths, numstat } = await changedSince($, scope, subject?.cwd, subject?.paths)

  if (numstat === undefined) {
    return undefined
  }

  const untracked = scope === 'tree' ? await untrackedFiles($, subject?.cwd, paths) : []

  return fingerprintOf($, range, limit, untracked, subject?.cwd)
}

async function usersOf($: EngineInterface, file: ChangedFile, cwd?: string): Promise<ChangedFile> {
  const query = usersQuery(file.path)

  if (query === undefined || file.isNew) {
    return file
  }

  const found = (await git($, ['grep', '--full-name', ...query], inside(cwd))) ?? ''

  return { ...file, usedBy: countUsers(found, file.path) }
}

async function jevOf($: EngineInterface, key: string | undefined, { body, hunks }: ReturnType<typeof askOf>): Promise<Jev> {
  if (key === undefined || key === '') {
    return { status: 'off' }
  }

  const startedAt = Date.now()

  try {
    const answered = await $.http.fetch(JEV_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body,
    })

    return { ...parseJev(answered.status, answered.text, hunks), tookMs: Date.now() - startedAt }
  } catch {
    return { status: 'failed', note: 'Jev could not be reached; triage used blast radius only.', tookMs: Date.now() - startedAt }
  }
}

/** Already staged files, from the top of the repo (`:/`) since `cwd` may be a subfolder; `undefined` when git failed. */
async function stagedPaths($: EngineInterface, cwd?: string) {
  const listed = await git($, ['diff', '--cached', '--name-only', '-z'], inside(cwd))

  return listed
    ?.split('\0')
    .filter(Boolean)
    .map(path => `:/${path}`)
}

/**
 * With `added` paths, the change is what was staged plus those paths against HEAD. A staged file's unstaged edits are
 * counted too, which errs towards judging more.
 */
async function changedSince($: EngineInterface, scope: Scope, cwd?: string, added?: string[]) {
  const first = scope === 'staged' ? '--cached' : 'HEAD'
  const staged = added === undefined ? undefined : await stagedPaths($, cwd)
  const limit = added === undefined || staged === undefined ? [] : pathspec([...staged, ...added])
  const paths = limit.length === 0 ? undefined : added
  const numstat = await git($, ['diff', first, '--numstat', ...limit], inside(cwd))

  if (numstat !== undefined || scope === 'staged') {
    return { range: first, limit, paths, numstat }
  }

  return { range: EMPTY_TREE, limit, paths, numstat: await git($, ['diff', EMPTY_TREE, '--numstat', ...limit], inside(cwd)) }
}

async function runTriage(
  $: EngineInterface,
  options: PluginOptions,
  scope: Scope = 'tree',
  cwd?: string,
  added?: string[],
  command?: string,
): Promise<Triage | null> {
  const { range, limit, paths, numstat } = await changedSince($, scope, cwd, added)

  if (numstat === undefined) {
    return null
  }

  const untracked = scope === 'tree' ? await untrackedFiles($, cwd, paths) : []
  const tracked = parseNumstat(numstat)

  if (tracked.length === 0 && untracked.length === 0) {
    await update($, triage, () => null)

    return null
  }

  const diff = (await git($, ['diff', range, ...limit], inside(cwd))) ?? ''
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
  const jev = await jevOf($, key, askOf(blast, patch, jevModelOf(options)))
  const subject: Subject = { scope, ...(cwd === undefined ? {} : { cwd }), ...(added === undefined ? {} : { paths: added }) }
  const judged: Triage = {
    subject,
    fingerprint: await fingerprintOf($, range, limit, untracked, cwd),
    ...verdictOf(blast, jev),
    blast,
    jev,
    isPatchCut: fullPatch.length > PATCH_CHARS,
    assessedAt: Date.now(),
    ...(command === undefined ? {} : { command }),
  }

  await update($, triage, () => judged)

  return judged
}

async function briefOf($: EngineInterface) {
  const reply = await $.model.fork({ prompt: BRIEF_PROMPT }).catch(() => undefined)

  return reply?.isAnswered === true ? reply.text.trim().slice(0, BRIEF_CHARS) : undefined
}

/** Puts `text` in the prompt box after whatever the user has typed there, never over it. */
async function fillKeepingDraft($: EngineInterface, text: string) {
  const draft = (await $.prompt.read()).text

  return draft.trim() === ''
    ? $.prompt.fill({ text, mode: 'replace' })
    : $.prompt.fill({ text: `

${text}`, mode: 'append' })
}

async function markEdited($: EngineInterface) {
  await update($, review, held => (held.status === 'done' && held.isEdited !== true ? { ...held, isEdited: true } : held))
  await update($, triage, held => (held !== null && held.isEdited !== true ? { ...held, isEdited: true } : held))
}

const jevModelOf = (options: PluginOptions) =>
  typeof options.jevModel === 'string' && options.jevModel !== '' ? options.jevModel : JEV_MODEL

async function runCodex($: EngineInterface, options: PluginOptions, focus = '') {
  const startedAt = Date.now()
  const judged = await read($, triage)
  const fingerprint = judged?.fingerprint
  const subject = subjectKey(judged?.subject)
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
  let isTimedOut = false
  const deadline = $.clock.sleep(REVIEW_TIMEOUT_MS).then(
    (): typeof TIMED_OUT => TIMED_OUT,
    () => new Promise<never>(() => undefined),
  )

  try {
    const child = $.process.spawn({
      argv: isWindows ? ['cmd.exe', '/d', '/c', ...codex] : codex,
      input: reviewPrompt(judged, focus, intent),
    })

    for (;;) {
      const pulled = await Promise.race([child.next(), deadline])

      if (pulled === TIMED_OUT) {
        isTimedOut = true
        void child.return({ code: null, signal: null }).catch(() => undefined)
        break
      }

      if (pulled.done === true) break

      const piece = pulled.value
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
    }

    exit = isTimedOut ? null : (await child.result.catch(() => ({ code: null }))).code
  } catch {
    exit = undefined
  }

  const text =
    exit === undefined
      ? 'Codex could not be started. Is the codex CLI installed and logged in?'
      : isTimedOut
        ? `Codex was stopped after ${REVIEW_TIMEOUT_MS / 60_000} minutes. ${lastLine(said.stdout) ?? lastLine(said.stderr) ?? ''}`.trim()
        : (said.stdout.trim() || said.stderr.trim() || 'Codex printed nothing.').slice(-REVIEW_CHARS)
  const done: Review = {
    status: 'done',
    covers,
    ...told,
    ...parseReview(text),
    tookMs: Date.now() - startedAt,
    isClean: exit === 0,
    ...(isTimedOut ? { isTimedOut } : {}),
    ...(fingerprint === undefined ? {} : { fingerprint }),
    ...(subject === undefined ? {} : { subject }),
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

/**
 * Approves the current assessment if the change still matches it, else marks it stale. `drawn` is the fingerprint
 * the pane showed; a newer assessment since then is left for the user to see first.
 */
async function approve($: EngineInterface, drawn?: string) {
  const judged = await read($, triage)

  if (judged === null || (drawn !== undefined && drawn !== judged.fingerprint)) {
    return 'missing'
  }

  const now = await fingerprintNow($, judged.subject)

  if (now !== undefined && now !== judged.fingerprint) {
    await update($, triage, held => (held?.fingerprint === judged.fingerprint ? { ...held, isEdited: true } : held))

    return 'stale'
  }

  await update($, approved, list => [...new Set([...list, judged.fingerprint])])
  await update($, triage, held => (held?.fingerprint === judged.fingerprint ? { ...held, isEdited: false } : held))

  return 'approved'
}

/** Approves, then puts the request to commit in the prompt box, as Send to Claude does for a review. */
async function approveAndAsk($: EngineInterface, drawn?: string) {
  const outcome = await approve($, drawn)
  const judged = await read($, triage)

  if (outcome !== 'approved' || judged === null) {
    return { outcome, isFilled: false }
  }

  return { outcome, isFilled: (await fillKeepingDraft($, commitPrompt(judged))).isFilled }
}

const openPane = ($: EngineInterface) => $.ui.open({ id: PANE, title: TITLE })

async function gate($: EngineInterface, options: PluginOptions, command: string, isPosix: boolean) {
  const commit = commitIn(command, isPosix)

  if (commit === undefined) {
    return undefined
  }

  const judged = await runTriage($, options, commit.scope, commit.cwd, commit.paths, command)

  if (judged === null || (await read($, approved)).includes(judged.fingerprint)) {
    return undefined
  }

  if (judged.verdict === 'hold') {
    void openPane($)

    return `triage-gate held this commit for human review. Why: ${judged.reasons.join('; ')}. Do not retry the commit or work around this hold. Tell the user: they can read the change, run /gate codex for a Codex review, or run /gate approve to let this exact change through.`
  }

  if (judged.verdict === 'read') {
    $.ui.toast(`Committed; review recommended: ${judged.reasons.slice(0, 2).join('; ')}. /gate shows what to read.`, {
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
      argumentHint: '[approve | details | codex [what to focus on]]',
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
      await markEdited($)
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const ran = await next(e)

    if (ran.deny === undefined && ran.isError !== true) {
      await update($, turn, held => addWrite(held, e.file_path, e.content))
      await markEdited($)
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
    const filled = await fillKeepingDraft($, prompt)

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
      const { outcome, isFilled } = await approveAndAsk($)
      const judged = await read($, triage)

      return {
        text:
          outcome === 'missing'
            ? 'Nothing has been triaged yet. Run /gate first.'
            : outcome === 'stale'
              ? 'Not approved: the change has been edited since it was assessed. Run /gate to assess it again.'
              : isFilled
                ? 'Approved. The request to commit is in your prompt box: press Enter to send it. Any further edit needs triage again.'
                : `Approved. Send this to commit; any further edit needs triage again.\n\n${judged === null ? '' : commitPrompt(judged)}`,
      }
    }

    if (asked === 'details') {
      const judged = await read($, triage)

      return { text: judged === null ? 'Nothing has been triaged yet. Run /gate first.' : detailsText(judged) }
    }

    if (asked === 'codex' || asked.startsWith('codex ')) {
      void openPane($)
      const done = await runCodex($, options, asked.slice('codex'.length).trim())

      return { text: `${reviewHeadline(done)}. See the Triage pane.` }
    }

    void openPane($)
    const judged = await runTriage($, options)

    return { text: judged === null ? 'Nothing uncommitted to triage.' : summaryOf(judged) }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const judged = await read($, triage)
    const view = {
      judged,
      reviewed: await read($, review),
      isApproved: judged !== null && (await read($, approved)).includes(judged.fingerprint),
      isOpen: await read($, details),
      isScrollHinted: e.props.placement === 'inline' && !e.props.isFocused,
    }

    return paneOf($.ui.resolve(e), view, {
      approve: fingerprint => approveAndAsk($, fingerprint),
      toggleDetails: () => update($, details, open => !open),
      triage: () =>
        runTriage($, options, judged?.subject?.scope, judged?.subject?.cwd, judged?.subject?.paths, judged?.command),
      codex: () => runCodex($, options),
      send: text => fillKeepingDraft($, text),
    })
  })
}
