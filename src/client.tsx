/**
 * `dsh-retry-button` browser half.
 *
 * ## What this adds
 *
 * A **Retry** button on a turn that ended without answering the user's request,
 * so the user does not have to type "继续" by hand. It covers two cases:
 *
 * 1. **Request failure** — the turn ended with `reason.kind === 'error'`
 *    (provider error, exhausted automatic retries). The shipped
 *    `dsh-client-ui-chat` already renders a `turn-error` row for this; we
 *    replace that row's renderer to add the button.
 * 2. **User cancellation** — the turn ended with `reason.kind === 'aborted'`
 *    and cancel cause `user`, i.e. the human pressed stop. The shipped UI
 *    renders only a turn footer here, no notice, so we contribute our own
 *    Conversation Definition and node kind.
 *
 * ## Why two mechanisms
 *
 * `conversation.chat.node` is a *keyed* slot: registering an occupant for an
 * existing `key` replaces that node's renderer. That is exactly right for case
 * 1 — the failure predicate stays owned by `dsh-client-ui-chat` and we only add
 * the missing action.
 *
 * The shipped `turn-error` Definition matches only `error` (plus the signed-out
 * abort), so case 2 has no node to replace. Rather than fork that predicate, we
 * register our own Definition that matches the wider set and classify the
 * reason with `classifyTurnEnd` — one tested function that documents every
 * exclusion.
 *
 * ## How the retry actually runs
 *
 * The button does not fabricate Session events and does not reach into the
 * agent loop. It puts the recovered original message back into the composer
 * through `inputActions.setDraft(...)` and then calls `inputActions.submit()`,
 * which is the same adjudication and submit path a typed message takes. The
 * resulting turn is therefore an ordinary turn in the durable log: fully
 * replayable and visible to every other consumer.
 *
 * ## Scope and limits
 *
 * Retrying re-sends the turn's opening *human* message. Synthetic injected
 * context (file notices, skill catalogs, cron wakeups) and goal continuation
 * rounds are never replayed, because presenting loop-internal context as human
 * intent would be wrong. When no replayable human text exists — an
 * attachment-only prompt, or a turn opened purely by injected context — the
 * button is not offered.
 *
 * This runs a new turn rather than re-running the single failed step: the
 * latter requires a `{ kind: 'retry' }` decision inside the agent loop's
 * `agent/request-error` waterfall, which is not reachable from a client
 * plugin.
 *
 * @module dsh-retry-button/client
 */

import * as React from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import { NS, en, zh } from './locale.js'

// The `ctx.slots`, `ctx.locale`, `ctx.sessions`, and `ctx.uiConversation`
// service declarations, plus the slot/locale/chat-node registry merges this
// plugin registers against, are contributed by these packages' `/client`
// entries. Importing them for their types puts those declarations in the
// program; the runtime values come from the module table, not from these
// imports.
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {
  ChatConversationViewNode,
  ChatNodeDataMap,
  TurnErrorNode,
} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {
  ConversationMatch,
  ConversationNodeContext,
  ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import { classifyTurnEnd, recoverPrompt, turnEndReason } from './turn-outcome.js'

/**
 * Chat node kind for a turn the user cancelled.
 *
 * Contributed through the chat package's public `ChatNodeDataMap` merge
 * surface, which exists for exactly this: payloads owned by other plugins.
 */
export interface TurnCancelledNode {
  readonly kind: 'turn-cancelled'
  /** Seq of the owning `turn/end` event. */
  readonly seq: number
  /** Unix epoch ms from the `turn/end` event. */
  readonly time: number
  readonly turn: number
  readonly step: number
}

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    /** A turn the user cancelled; carries the manual-retry affordance. */
    'turn-cancelled': TurnCancelledNode
  }
}

/** Failure codes that must never offer a retry. */
const NO_RETRY_CODES: ReadonlySet<string> = new Set(['ACCOUNT_SIGNED_OUT'])

/**
 * Slot shadowing rank for both rows.
 *
 * A keyed slot rejects a second entry for the same `key` at the same
 * `priority`, and the default rank is `0` — exactly what the shipped
 * `turn-error` renderer holds. Replacing that renderer therefore requires an
 * explicitly *lower* rank, because the lowest rank is the one that renders.
 * Without this, registration throws and the whole plugin fails to activate.
 */
const SLOT_PRIORITY = -1

/**
 * Sort offset placing this row just after the `turn/end` event and therefore
 * before the turn's `turn-tail` footer, which the chat target anchors at
 * `seq + finalizedFollowup` (a positive offset). Keeping the footer last
 * preserves its own restore/branch actions as the turn's final row.
 */
const BEFORE_TURN_TAIL = -0.05

/** Services the browser half requires. */
export const inject = ['slots', 'sessions', 'locale', 'uiConversation']

/** Styles injected with the plugin, so no shipped stylesheet is modified. */
const STYLE = `
.dsh-retry-button-row{display:flex;align-items:center;gap:8px;margin-top:6px;flex-wrap:wrap}
.dsh-retry-button{appearance:none;border:1px solid var(--dsh-border-color,currentColor);background:transparent;color:inherit;font:inherit;font-size:12px;line-height:1;padding:5px 10px;border-radius:6px;cursor:pointer;opacity:.9}
.dsh-retry-button:hover:not(:disabled){opacity:1;background:color-mix(in srgb,currentColor 10%,transparent)}
.dsh-retry-button:disabled{opacity:.45;cursor:default}
.dsh-retry-button-hint{font-size:11px;opacity:.6}
.dsh-retry-button-error{font-size:11px;color:var(--dsh-danger-color,#e5534b)}
`

/**
 * Narrow read-only view of the client Session service this plugin needs.
 *
 * Declared structurally so the plugin depends only on the one operation it
 * uses, and stays readable if the wider service grows.
 */
interface SessionReader {
  binding(id: SessionId):
    | { eventSource: { getSnapshot(): { entries: readonly unknown[] } | undefined } }
    | undefined
}

/**
 * Session-service handle for the renderers.
 *
 * A keyed Chat renderer receives Session standard props but not the Cordis
 * context. Cordis provides the service through React context instead of a
 * module-global, so a disposed or replaced plugin instance can never leave a
 * stale handle behind for a later render.
 */
const SessionsContext = React.createContext<SessionReader | undefined>(undefined)

/** What a row needs to offer a retry, or to say why it cannot. */
interface RetryOffer {
  readonly text: string | undefined
  /** Present when no retry is possible, to explain why. */
  readonly blockedBy: 'no-message' | 'unavailable' | undefined
}

/** Read the failed turn's opening human message from the durable window. */
function useRetryOffer(turn: number, sessionId: SessionId, enabled: boolean): RetryOffer {
  const sessions = React.useContext(SessionsContext)
  return React.useMemo(() => {
    if (!enabled) return { text: undefined, blockedBy: undefined }
    const binding = sessions?.binding(sessionId)
    const window = binding?.eventSource.getSnapshot()
    if (window === undefined) return { text: undefined, blockedBy: 'no-message' }
    const prompt = recoverPrompt(window.entries as readonly SessionEventLikeEntry[], turn)
    if (prompt === undefined) return { text: undefined, blockedBy: 'no-message' }
    return { text: prompt.text, blockedBy: undefined }
  }, [sessions, sessionId, turn, enabled])
}

/** Props shared by both row renderers. */
interface RetryRowProps {
  readonly turn: number
  readonly sessionId: SessionId
  readonly inputActions: { setDraft(text: string): void; submit(): void }
  readonly running: boolean
  readonly enabled: boolean
  readonly t: (key: string, params?: Record<string, unknown>) => string
  /** Failure copy shown beside the button on the error row. */
  readonly failure?: { readonly message: string; readonly code?: string }
}

/**
 * The shared Retry action row.
 *
 * Used by both the replaced `turn-error` renderer and the contributed
 * `turn-cancelled` renderer, so the two paths cannot drift apart.
 */
function RetryRow(props: RetryRowProps): React.ReactElement {
  const { turn, sessionId, inputActions, running, enabled, t, failure } = props
  const offer = useRetryOffer(turn, sessionId, enabled)
  const [busy, setBusy] = React.useState(false)
  const [refused, setRefused] = React.useState(false)

  // A live turn already owns the submit plane, so retrying while one runs
  // would either be refused or interleave with it.
  const disabled = busy || running || offer.text === undefined

  const onRetry = React.useCallback(() => {
    if (offer.text === undefined) return
    setRefused(false)
    setBusy(true)
    try {
      // Same path a typed message takes: seed the draft, then submit.
      inputActions.setDraft(offer.text)
      inputActions.submit()
    } catch {
      setRefused(true)
      setBusy(false)
      return
    }
    // Submission is asynchronous, so success cannot be confirmed here. Clear
    // the in-flight flag on the next tick rather than leaving the action stuck
    // if the submit plane refuses later; `running` still guards a live turn.
    window.setTimeout(() => setBusy(false), 0)
  }, [inputActions, offer.text])

  const why =
    failure !== undefined && failure.code !== undefined && NO_RETRY_CODES.has(failure.code)
      ? failure.message
      : offer.blockedBy === 'no-message'
        ? t('error.noMessage')
        : undefined

  return React.createElement(
    'div',
    { className: 'dsh-retry-button-row' },
    React.createElement(
      'button',
      {
        type: 'button',
        className: 'dsh-retry-button',
        title: t('title.retry'),
        disabled,
        onClick: onRetry,
      },
      busy ? t('action.retrying') : t('action.retry'),
    ),
    offer.text !== undefined
      ? React.createElement('span', { className: 'dsh-retry-button-hint' }, t('hint.retry'))
      : null,
    why !== undefined
      ? React.createElement('span', { className: 'dsh-retry-button-error' }, why)
      : null,
    refused
      ? React.createElement(
          'span',
          { className: 'dsh-retry-button-error' },
          t('error.unavailable'),
        )
      : null,
  )
}

/** Props a keyed Chat row renderer receives from the slot framework. */
interface ChatRowProps {
  node: { data: { turn: number } & Record<string, unknown> }
  t: (key: string, params?: Record<string, unknown>) => string
  inputActions: { setDraft(text: string): void; submit(): void }
  sessionId: SessionId
  useSession: <Selected>(
    selector: (value: { running: boolean }) => Selected,
    equal?: (left: Selected, right: Selected) => boolean,
  ) => Selected
}

/**
 * Replacement renderer for the shipped `turn-error` row.
 *
 * @param props - keyed Chat node props plus Session standard props and locale.
 * @returns the failure row with a manual-retry action.
 */
function TurnErrorRetryView(props: ChatRowProps): React.ReactElement {
  const data = props.node.data as unknown as TurnErrorNode
  const running = props.useSession((state) => state.running)
  // The signed-out abort is presented by the shipped copy and cannot succeed
  // until the user signs in, so no retry is offered for it.
  const enabled = !NO_RETRY_CODES.has(data.code ?? '')
  return React.createElement(RetryRow, {
    turn: data.turn,
    sessionId: props.sessionId,
    inputActions: props.inputActions,
    running,
    enabled,
    t: props.t,
    failure: { message: data.message, ...(data.code === undefined ? {} : { code: data.code }) },
  })
}

/**
 * Renderer for a turn the user cancelled.
 *
 * @param props - keyed Chat node props plus Session standard props and locale.
 * @returns the cancellation row with a manual-retry action.
 */
function TurnCancelledRetryView(props: ChatRowProps): React.ReactElement {
  const data = props.node.data as unknown as TurnCancelledNode
  const running = props.useSession((state) => state.running)
  return React.createElement(RetryRow, {
    turn: data.turn,
    sessionId: props.sessionId,
    inputActions: props.inputActions,
    running,
    enabled: true,
    t: props.t,
  })
}

/** The turn a `turn/end` event closed. */
function endedTurn(event: { data: { turn?: number; reason?: unknown } }): number | undefined {
  const turn = event.data.turn
  return typeof turn === 'number' ? turn : undefined
}

/**
 * Contributed Definition for a user-cancelled turn.
 *
 * The shipped `turn-error` Definition covers only `error`, so this covers the
 * wider set this plugin retries. `classifyTurnEnd` owns the decision; this
 * Definition only materializes the row.
 */
const turnCancelledDefinition: ConversationNodeDefinition<{
  turn: number
  seq: number
  time: number
}> = {
  kind: 'turn-cancelled',
  target: 'chat',
  match: (event) => {
    if (event.type === 'turn/start') return { id: String(event.data.turn), role: 'start' }
    if (event.type !== 'turn/end') return null
    const outcome = classifyTurnEnd((event.data as { reason?: unknown }).reason)
    // Only the cancellation case gets this row. `error` is already covered by
    // the shipped row, whose renderer this plugin replaces.
    if (!outcome.retryable || outcome.cause !== 'cancelled') return null
    return { id: String(event.data.turn), role: 'update' }
  },
  start: (_context, match) => {
    if (match.event.type !== 'turn/start') {
      throw new Error('turn-cancelled start requires turn/start')
    }
    return { turn: match.event.data.turn, seq: match.event.seq, time: match.event.time }
  },
  update: (context, match) => {
    const turn = endedTurn(match.event as { data: { turn?: number; reason?: unknown } })
    if (turn === undefined) return context.state
    return { turn, seq: match.event.seq, time: match.event.time }
  },
  buildViewNode: (context: ConversationNodeContext<{
    turn: number
    seq: number
    time: number
  }>): ChatConversationViewNode | null => {
    const state = context.state
    if (state === undefined) return null
    const steps = context.start?.location
    const step =
      steps !== undefined && (steps.kind === 'turn' || steps.kind === 'step')
        ? (steps.turn.steps.at(-1)?.step ?? 0)
        : 0
    // Mirrors the shipped chat-node builder: the engine owns `key`/`id`, this
    // Definition owns the payload and placement. The node sorts just before the
    // turn footer so the footer stays the turn's last row and keeps its own
    // actions enabled.
    const data: TurnCancelledNode = {
      kind: 'turn-cancelled',
      seq: state.seq,
      time: state.time,
      turn: state.turn,
      step,
    }
    return {
      key: context.key,
      kind: 'turn-cancelled',
      id: context.id,
      target: 'chat',
      anchorSeq: state.seq + BEFORE_TURN_TAIL,
      location: context.start?.location ?? (context.matches[0] as ConversationMatch).location,
      visibility: 'visible',
      data,
    }
  },
}

/**
 * Browser plugin body: register the rows, their copy, and their styles.
 *
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  const sessions = ctx.sessions as unknown as SessionReader

  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'retry-button: dictionaries')

  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.dshPlugin = 'retry-button'
    style.textContent = STYLE
    document.head.append(style)
    return () => {
      style.remove()
    }
  }, 'retry-button: styles')

  // Hand the Session service to the renderers through React context, bound to
  // this plugin instance's lifetime.
  const withSessions = (View: (props: ChatRowProps) => React.ReactElement) =>
    function BoundView(props: ChatRowProps) {
      return React.createElement(
        SessionsContext.Provider,
        { value: sessions },
        React.createElement(View, props),
      )
    }

  // Case 1: replace the shipped terminal-failure renderer. The Definition that
  // decides *when* that row exists stays owned by dsh-client-ui-chat.
  ctx.slots.inject('conversation.chat.node', () =>
    ctx.slots.register(
      { name: 'conversation.chat.node', key: 'turn-error', priority: SLOT_PRIORITY, locale: NS },
      withSessions(TurnErrorRetryView) as never,
    ),
  )

  // Case 2: contribute the cancellation row the shipped UI does not build.
  ctx.uiConversation.events.register(turnCancelledDefinition)
  ctx.slots.inject('conversation.chat.node', () =>
    ctx.slots.register(
      {
        name: 'conversation.chat.node',
        key: 'turn-cancelled',
        priority: SLOT_PRIORITY,
        locale: NS,
      },
      withSessions(TurnCancelledRetryView) as never,
    ),
  )
}

/** Re-exported for tests and for callers that need the shared classifier. */
export { classifyTurnEnd, recoverPrompt, turnEndReason }
export type { ChatNodeDataMap }