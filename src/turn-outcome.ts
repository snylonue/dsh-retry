/**
 * Classify a turn's terminal reason into the cases this plugin can offer a
 * retry for, and recover the message to re-send.
 *
 * ## Why classification lives here
 *
 * The shipped `dsh-client-ui-chat` builds its `turn-error` row only for
 * `reason.kind === 'error'` (plus the signed-out abort). This plugin covers a
 * strictly wider set — adding user-initiated cancellation — so it cannot reuse
 * that row's condition and must decide for itself. Keeping the whole rule in
 * one tested function is what makes the widening auditable.
 *
 * ## What a retry means
 *
 * The user asked to retry: "run my request again." That is only meaningful when
 * the turn ended without the model answering it. Two reasons qualify:
 *
 * - `error` — the request failed (provider error, exhausted auto-retries). The
 *   prompt was never processed.
 * - `aborted` with cause `user` — the human pressed stop, or the client
 *   cancelled on their behalf. The prompt was not completed.
 *
 * ## What must NOT qualify
 *
 * Every exclusion below is a case where re-sending the same prompt would be
 * wrong, harmful, or meaningless:
 *
 * | Reason | Why not |
 * |---|---|
 * | `completed` | The turn succeeded; there is nothing to redo. |
 * | `max-tokens` | The model answered but hit its cap. The right follow-up is "keep going", not "redo" — different intent, different semantics. |
 * | `blocked` | A policy/hook refused the turn. Re-sending cannot change a policy decision. |
 * | `interrupted` | A crash closed an already-dead turn. Resume continues the session; there is no live request to re-issue. |
 * | `forked` | Only fork-seed construction writes this. Not a failure at all. |
 * | `aborted` / `parent` | A parent agent cancelled this one (a subagent being torn down). User retry is not the remedy. |
 * | `aborted` / `hook` | Another plugin aborted. Its reason string is plugin-owned; the signed-out case is explicitly excluded. |
 * | `aborted` / `disposed` | The host was shutting down or the plugin unloaded. Nothing to re-run. |
 * | `aborted` / `legacy` | Imported history with no recorded cause. We cannot tell who cancelled, so we do not guess. |
 *
 * @module turn-outcome
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'

/** Why a retry is offered, or why it is not. */
export type TurnOutcome =
  | { readonly retryable: true; readonly cause: 'error' | 'cancelled' }
  | { readonly retryable: false }

/** Labels for the copy that explains the non-retryable cases. */
export type TurnOutcomeReason = 'completed' | 'max-tokens' | 'blocked' | 'other'

/** One classified terminal reason. */
export interface ClassifiedOutcome {
  /** Whether this plugin offers a retry for the turn. */
  readonly retryable: boolean
  /** For a retryable turn, why — this selects the user-facing wording. */
  readonly cause?: 'error' | 'cancelled'
  /** For a non-retryable turn, why. */
  readonly reason?: TurnOutcomeReason
}

/**
 * Classify one `turn/end` reason.
 *
 * @param reason - the durable `turn/end` reason payload.
 * @returns the classification; never throws on unknown variants, because the
 *   reason map is merge-extensible and a future plugin may add cases.
 */
export function classifyTurnEnd(reason: unknown): ClassifiedOutcome {
  if (typeof reason !== 'object' || reason === null) return { retryable: false, reason: 'other' }
  const kind = (reason as { kind?: unknown }).kind

  if (kind === 'error') return { retryable: true, cause: 'error' }

  if (kind === 'aborted') {
    const cause = (reason as { reason?: { kind?: unknown; reason?: unknown } }).reason
    if (typeof cause !== 'object' || cause === null) return { retryable: false, reason: 'other' }
    // Only a human-driven cancellation is retryable. Every other cause denies
    // it: `parent` (a parent agent tore this one down), `disposed` (host or
    // plugin shutdown), `legacy` (imported history with no recorded cause, so
    // we cannot know who cancelled), and `hook` — which includes the
    // signed-out abort the shipped error row already presents.
    if (cause.kind === 'user') return { retryable: true, cause: 'cancelled' }
    return { retryable: false, reason: 'other' }
  }

  if (kind === 'completed') return { retryable: false, reason: 'completed' }
  if (kind === 'max-tokens') return { retryable: false, reason: 'max-tokens' }
  if (kind === 'blocked') return { retryable: false, reason: 'blocked' }
  return { retryable: false, reason: 'other' }
}

/**
 * Extract the plain text of one message's content blocks.
 *
 * Only text blocks carry replayable user intent; image and file blocks are
 * durable attachment references whose re-send would need the full composer
 * attachment path, so a message that carries nothing but attachments is not
 * offered for retry. Blocks are joined with a blank line so multi-block
 * prompts keep their shape.
 *
 * @param content - the model-facing content blocks of one message.
 * @returns the joined text, or an empty string when there is no text.
 */
export function textOf(content: readonly ContentBlock[]): string {
  const parts: string[] = []
  for (const block of content) {
    if (block.type === 'text' && block.text.trim() !== '') parts.push(block.text)
  }
  return parts.join('\n\n').trim()
}

/**
 * Whether one durable event is a genuine, human-authored prompt.
 *
 * Synthetic injections and goal continuation rounds are `user/message` events
 * with a non-`user` source kind, so they are rejected here. This mirrors the
 * presentation layer's classifier rather than inventing a second one.
 *
 * @param event - one durable Session event.
 * @returns whether the event is a human prompt safe to replay.
 */
export function isHumanPrompt(
  event: SessionEventLikeEntry['event'],
): event is SessionEventLikeEntry['event'] & {
  type: 'user/message'
  data: { source: { kind: 'user' } }
} {
  if (event.type !== 'user/message') return false
  const source = (event.data as { source?: { kind?: string } }).source
  return source?.kind === 'user'
}

/** One recovered human message, positioned in the failed turn. */
export interface RecoveredPrompt {
  /** The text to hand back to the composer. */
  readonly text: string
  /** Durable sequence of the originating `user/message` event. */
  readonly seq: number
}

/**
 * Find the human message that opened (or steered) the given turn.
 *
 * A turn may contain more than one human message when the user steered a
 * running turn. The retry re-sends the turn's *opening* prompt — the first
 * genuine human message at or after `turn/start` — because that is the request
 * the turn was answering, and re-sending a later steering message out of
 * context would change its meaning.
 *
 * @param entries - the contiguous durable event window.
 * @param turn - the turn number.
 * @returns the recovered prompt, or undefined when the turn has no replayable human text.
 */
export function recoverPrompt(
  entries: readonly SessionEventLikeEntry[],
  turn: number,
): RecoveredPrompt | undefined {
  // Locate the turn's start, then scan forward until the next turn begins:
  // a turn's events are contiguous by construction.
  let startIndex = -1
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    if (entry?.type !== 'event') continue
    if (entry.event.type !== 'turn/start') continue
    if ((entry.event.data as { turn?: number }).turn === turn) {
      startIndex = index
      break
    }
  }
  if (startIndex === -1) return undefined

  for (let index = startIndex; index < entries.length; index += 1) {
    const entry = entries[index]
    if (entry?.type !== 'event') continue
    const event = entry.event
    // The next turn's start closes the window of interest.
    if (index > startIndex && event.type === 'turn/start') return undefined
    if (!isHumanPrompt(event)) continue
    const text = textOf((event.data as { content: readonly ContentBlock[] }).content)
    if (text === '') continue
    return { text, seq: event.seq }
  }
  return undefined
}

/**
 * Find the terminal `turn/end` event for one turn.
 *
 * @param entries - the contiguous durable event window.
 * @param turn - the turn number.
 * @returns the reason payload, or undefined when the closer is not loaded.
 */
export function turnEndReason(
  entries: readonly SessionEventLikeEntry[],
  turn: number,
): unknown {
  for (const entry of entries) {
    if (entry?.type !== 'event') continue
    const event = entry.event
    if (event.type !== 'turn/end') continue
    if ((event.data as { turn?: number }).turn !== turn) continue
    return (event.data as { reason?: unknown }).reason
  }
  return undefined
}