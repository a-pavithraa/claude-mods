import type { Elements, RenderInput } from 'claude-code'

import type { Judgment, Review, Triage } from '../types'
import { startWith } from './blast'
import { MEANS } from './jev'
import { BADGE, changeLine, coverageOf, diagnosticsOf, reviewHeadline, subjectKey } from './report'
import { fixPrompt, tookOf } from './review'
import { likelihood, percent } from './verdict'

const RISK_SIGNALS = ['security', 'data', 'money', 'concurrency', 'publicApi', 'behaviour', 'mixed']

export type PaneView = {
  judged: Triage | null
  reviewed: Review
  isApproved: boolean
  isOpen: boolean
  isScrollHinted: boolean
}

export type PaneActions = {
  approve: (fingerprint: string) => Promise<unknown>
  toggleDetails: () => Promise<unknown>
  triage: () => Promise<unknown>
  codex: () => Promise<unknown>
  send: (text: string) => Promise<unknown>
}

/** A risk signal's tone; for "has tests" a high value is the good news. */
const toneOf = (one: Judgment) => {
  const risk = one.key === 'tested' ? 1 - one.value : one.value

  return risk >= 0.7 ? 'error' : risk >= 0.3 ? 'warning' : undefined
}

export function paneOf(ui: Elements[RenderInput<'Pane'>['surface']], view: PaneView, act: PaneActions) {
  const { Box, Button, Text } = ui
  const { judged, reviewed, isApproved, isOpen } = view

  const isOtherChange =
    reviewed.status === 'done' &&
    reviewed.subject !== undefined &&
    judged?.subject !== undefined &&
    subjectKey(judged.subject) !== reviewed.subject
  const isStale =
    !isOtherChange &&
    reviewed.status === 'done' &&
    (reviewed.isEdited === true ||
      (judged !== null && reviewed.fingerprint !== undefined && reviewed.fingerprint !== judged.fingerprint))
  const reviewBox = (
    <Box flexDirection="column">
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

      {isOtherChange && (
        <Box marginTop={1}>
          <Text dimColor wrap="wrap">
            An earlier Codex review covered a different change. Run Codex review to check this one.
          </Text>
        </Box>
      )}

      {reviewed.status === 'done' && !isOtherChange && (
        <Box
          flexDirection="column"
          marginTop={1}
          borderStyle="round"
          borderColor={reviewed.findings.length > 0 || !reviewed.isClean ? 'warning' : 'subtle'}
          paddingX={1}
        >
          <Box>
            <Text bold color={reviewed.findings.length > 0 || !reviewed.isClean ? 'warning' : 'success'}>
              {reviewHeadline(reviewed)}
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
          {isStale && (
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
                  await act.send(fixPrompt(reviewed.findings))
                }}
              />
            </Box>
          )}
        </Box>
      )}
    </Box>
  )

  if (judged === null) {
    return (
      <Box flexDirection="column">
        <Text dimColor wrap="wrap">
          Nothing triaged yet. Triage runs when Claude commits, or type /gate.
        </Text>
        {reviewBox}
      </Box>
    )
  }

  const badge = BADGE[judged.verdict]
  const { jev } = judged
  const isWhole = jev.status === 'judged' && !judged.isPatchCut
  const heading = (text: string) => (
    <Box marginTop={1}>
      <Text bold>{text}</Text>
    </Box>
  )
  const signal = (one: Judgment) => (
    <Box key={one.key} flexDirection="column">
      <Box>
        <Box flexGrow={1} flexShrink={1}>
          <Text wrap="truncate-end">{one.label}</Text>
        </Box>
        <Text color={toneOf(one)}>
          {likelihood(one.value)} · {percent(one.value)}
        </Text>
      </Box>
      <Text dimColor wrap="wrap">
        {MEANS[one.key] ?? ''}
      </Text>
    </Box>
  )
  const judgments = jev.status === 'judged' ? jev.judgments : []
  const risks = judgments.filter(one => RISK_SIGNALS.includes(one.key))
  const tests = judgments.filter(one => one.key === 'tested')
  const readability: Judgment[] =
    jev.status === 'judged' ? [{ key: 'readability', label: 'hard to follow', value: jev.hardToRead }] : []

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={badge.tone} bold>
          {badge.mark} {badge.word}
        </Text>
        <Box flexGrow={1} />
        {isApproved && <Text color="success">approved</Text>}
      </Box>
      <Text dimColor wrap="wrap">
        {badge.means}
      </Text>
      <Text wrap="wrap">{changeLine(judged)}</Text>
      <Text color={isWhole ? undefined : 'warning'} dimColor={isWhole} wrap="wrap">
        {coverageOf(judged)}
      </Text>
      {judged.isEdited === true && (
        <Text color="warning" wrap="wrap">
          ▲ Claude edited files after this assessment. Refresh it.
        </Text>
      )}

      <Box marginTop={1} gap={1} flexWrap="wrap">
        {judged.verdict === 'hold' && !isApproved && (
          <Button
            key="approve"
            label="Approve commit"
            variant="primary"
            onPress={() => act.approve(judged.fingerprint)}
          />
        )}
        <Button
          key="codex"
          label={reviewed.status === 'running' ? 'Codex reviewing…' : 'Run Codex review'}
          onPress={async () => {
            if (reviewed.status !== 'running') {
              await act.codex()
            }
          }}
        />
        <Button key="rerun" label="Refresh assessment" onPress={async () => void (await act.triage())} />
      </Box>
      {view.isScrollHinted && (
        <Text dimColor wrap="wrap">
          Click the pane or press ctrl+x tab, then use the arrow keys to scroll to Why, Start with and the signals.
        </Text>
      )}

      {judged.reasons.length > 0 && heading('Why')}
      {judged.reasons.map(reason => (
        <Text wrap="wrap">· {reason}</Text>
      ))}

      {heading('Start with')}
      {startWith(judged.blast).map(({ file, why }) => (
        <Box key={file.path}>
          <Box flexShrink={1}>
            <Text color="suggestion" wrap="truncate-start">
              {file.path}
            </Text>
          </Box>
          <Box flexGrow={1} flexShrink={2}>
            <Text dimColor wrap="truncate-end">
              {' '}· {why}
            </Text>
          </Box>
        </Box>
      ))}

      {reviewBox}

      <Box marginTop={1}>
        <Button
          key="details"
          plain
          dimColor
          label={isOpen ? '▾ Hide detailed signals' : '▸ Detailed signals'}
          onPress={() => act.toggleDetails()}
        />
      </Box>
      {isOpen && jev.status !== 'judged' && (
        <Text dimColor wrap="wrap">
          {jev.status === 'off'
            ? 'Jev is not configured: set the TypeSafe API key in /config or TYPESAFE_API_KEY.'
            : 'Jev gave no judgement this time; see the line under the change summary.'}
        </Text>
      )}
      {isOpen && jev.status === 'judged' && (
        <Box flexDirection="column">
          <Text dimColor wrap="wrap">
            Jev's estimate that each statement holds for this diff.
          </Text>
          {heading('Risk')}
          {[...risks, ...readability].map(signal)}
          {heading('Tests')}
          {tests.map(signal)}
        </Box>
      )}
      {isOpen && (
        <Box flexDirection="column">
          {heading('Diagnostics')}
          <Text dimColor wrap="wrap">
            {diagnosticsOf(judged)}
          </Text>
        </Box>
      )}
    </Box>
  )
}
