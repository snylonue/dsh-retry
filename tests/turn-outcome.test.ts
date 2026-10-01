/**
 * Unit tests for turn-end classification and retry-message recovery.
 *
 * The classification tests are the safety net for this plugin's central claim:
 * it offers a retry exactly when the turn ended without answering the user's
 * request, and never for a completed, capped, policy-blocked, crash-closed, or
 * non-user-cancelled turn.
 */

import { describe, expect, it } from 'vitest'
import {
  classifyTurnEnd,
  isHumanPrompt,
  recoverPrompt,
  textOf,
  turnEndReason,
} from '../src/turn-outcome.js'

/** Build one durable entry the way the event window carries it. */
const event = (seq: number, type: string, data: unknown) => ({
  type: 'event' as const,
  event: { type, seq, time: 0, data } as never,
})

/** A `user/message` payload with the given source kind. */
const userMessage = (id: string, sourceKind: string, text: string, extra: object = {}) => ({
  id,
  role: 'user',
  content: [{ type: 'text', text }],
  source: { kind: sourceKind, ...extra },
})

describe('classifyTurnEnd', () => {
  it('retries a request failure', () => {
    expect(classifyTurnEnd({ kind: 'error', error: { code: 'SERVER' } })).toEqual({
      retryable: true,
      cause: 'error',
    })
  })

  it('retries a user cancellation', () => {
    expect(classifyTurnEnd({ kind: 'aborted', reason: { kind: 'user' } })).toEqual({
      retryable: true,
      cause: 'cancelled',
    })
  })

  it('does not retry a completed turn', () => {
    expect(classifyTurnEnd({ kind: 'completed' })).toEqual({
      retryable: false,
      reason: 'completed',
    })
  })

  it('does not retry a max-tokens turn', () => {
    // The model answered but hit its cap: "keep going" is the right follow-up,
    // not "redo the request".
    expect(classifyTurnEnd({ kind: 'max-tokens' })).toEqual({
      retryable: false,
      reason: 'max-tokens',
    })
  })

  it('does not retry a blocked turn', () => {
    expect(classifyTurnEnd({ kind: 'blocked' })).toEqual({ retryable: false, reason: 'blocked' })
  })

  it('does not retry a crash-closed turn', () => {
    expect(classifyTurnEnd({ kind: 'interrupted' })).toEqual({
      retryable: false,
      reason: 'other',
    })
  })

  it('does not retry a fork-seed turn', () => {
    expect(classifyTurnEnd({ kind: 'forked' })).toEqual({ retryable: false, reason: 'other' })
  })

  it('does not retry non-user cancellation causes', () => {
    for (const cause of [
      { kind: 'parent' },
      { kind: 'hook', reason: 'some-plugin/reason' },
      { kind: 'hook', reason: 'deepseek-account/signed-out' },
      { kind: 'disposed' },
      { kind: 'legacy' },
    ]) {
      expect(classifyTurnEnd({ kind: 'aborted', reason: cause })).toEqual({
        retryable: false,
        reason: 'other',
      })
    }
  })

  it('does not retry an aborted turn with no recorded cause', () => {
    expect(classifyTurnEnd({ kind: 'aborted' })).toEqual({ retryable: false, reason: 'other' })
  })

  it('fails closed on malformed or unknown reasons', () => {
    // The reason map is merge-extensible, so an unrecognized kind must not be
    // treated as retryable.
    for (const value of [null, undefined, 'error', 42, {}, { kind: 'some-future-reason' }]) {
      expect(classifyTurnEnd(value).retryable).toBe(false)
    }
  })
})

describe('textOf', () => {
  it('joins text blocks and drops empty ones', () => {
    expect(
      textOf([
        { type: 'text', text: 'first' },
        { type: 'text', text: '   ' },
        { type: 'text', text: 'second' },
      ] as never),
    ).toBe('first\n\nsecond')
  })

  it('ignores non-text blocks', () => {
    expect(
      textOf([
        { type: 'image', ref: 'x' },
        { type: 'text', text: 'hello' },
      ] as never),
    ).toBe('hello')
  })

  it('returns empty for attachment-only content', () => {
    expect(textOf([{ type: 'image', ref: 'x' }] as never)).toBe('')
  })
})

describe('isHumanPrompt', () => {
  it('accepts a user-sourced message', () => {
    expect(isHumanPrompt(event(1, 'user/message', userMessage('m', 'user', 'hi')).event)).toBe(true)
  })

  it('rejects synthetic injections and goal rounds', () => {
    for (const kind of ['inject', 'goal', 'system-prompt', 'tool']) {
      expect(isHumanPrompt(event(1, 'user/message', userMessage('m', kind, 'hi')).event)).toBe(false)
    }
  })

  it('rejects other event types', () => {
    expect(isHumanPrompt(event(1, 'turn/start', { turn: 1 }).event)).toBe(false)
  })
})

describe('recoverPrompt', () => {
  it('returns the opening human prompt of the turn', () => {
    const entries = [
      event(1, 'turn/start', { turn: 1 }),
      event(2, 'user/message', userMessage('a', 'user', 'do the thing')),
      event(3, 'step/start', { turn: 1, step: 1 }),
      event(4, 'turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'SERVER' } } }),
    ]
    expect(recoverPrompt(entries as never, 1)).toEqual({ text: 'do the thing', seq: 2 })
  })

  it('recovers the prompt of a user-cancelled turn', () => {
    const entries = [
      event(1, 'turn/start', { turn: 2 }),
      event(2, 'user/message', userMessage('a', 'user', 'cancelled request')),
      event(3, 'step/start', { turn: 2, step: 1 }),
      event(4, 'turn/end', { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } }),
    ]
    expect(recoverPrompt(entries as never, 2)).toEqual({ text: 'cancelled request', seq: 2 })
  })

  it('skips injected context and picks the real prompt', () => {
    const entries = [
      event(1, 'turn/start', { turn: 3 }),
      event(2, 'user/message', userMessage('ctx', 'inject', 'file changed: x.ts')),
      event(3, 'user/message', userMessage('real', 'user', 'actual request')),
    ]
    expect(recoverPrompt(entries as never, 3)).toEqual({ text: 'actual request', seq: 3 })
  })

  it('never crosses into another turn', () => {
    const entries = [
      event(1, 'turn/start', { turn: 1 }),
      event(2, 'step/start', { turn: 1, step: 1 }),
      event(3, 'turn/start', { turn: 2 }),
      event(4, 'user/message', userMessage('b', 'user', 'later turn')),
    ]
    expect(recoverPrompt(entries as never, 1)).toBeUndefined()
  })

  it('returns undefined when only synthetic context opened the turn', () => {
    const entries = [
      event(1, 'turn/start', { turn: 4 }),
      event(2, 'user/message', userMessage('ctx', 'inject', 'cron wakeup')),
    ]
    expect(recoverPrompt(entries as never, 4)).toBeUndefined()
  })

  it('returns undefined for an attachment-only prompt', () => {
    const entries = [
      event(1, 'turn/start', { turn: 5 }),
      event(2, 'user/message', {
        id: 'img',
        role: 'user',
        content: [{ type: 'image', ref: 'x' }],
        source: { kind: 'user' },
      }),
    ]
    expect(recoverPrompt(entries as never, 5)).toBeUndefined()
  })

  it('returns undefined for an unknown turn', () => {
    expect(recoverPrompt([event(1, 'turn/start', { turn: 1 })] as never, 99)).toBeUndefined()
  })

  it('ignores transient live-chunk entries', () => {
    const entries = [
      { type: 'transient', event: { type: 'assistant/live-chunk', seq: 0, data: {} } },
      event(1, 'turn/start', { turn: 6 }),
      { type: 'transient', event: { type: 'assistant/live-chunk', seq: 1, data: {} } },
      event(2, 'user/message', userMessage('c', 'user', 'with noise')),
    ]
    expect(recoverPrompt(entries as never, 6)).toEqual({ text: 'with noise', seq: 2 })
  })

  it('tolerates a turn whose events are not yet all loaded', () => {
    expect(recoverPrompt([event(1, 'turn/start', { turn: 7 })] as never, 7)).toBeUndefined()
  })
})

describe('turnEndReason', () => {
  it('finds the closer for the asked turn only', () => {
    const entries = [
      event(1, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
      event(2, 'turn/end', { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } }),
    ]
    expect(turnEndReason(entries as never, 2)).toEqual({ kind: 'aborted', reason: { kind: 'user' } })
    expect(classifyTurnEnd(turnEndReason(entries as never, 2))).toEqual({
      retryable: true,
      cause: 'cancelled',
    })
  })

  it('returns undefined when the closer is not loaded', () => {
    expect(turnEndReason([event(1, 'turn/start', { turn: 1 })] as never, 1)).toBeUndefined()
  })
})