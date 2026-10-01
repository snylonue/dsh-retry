/**
 * Locale dictionaries for the manual-retry affordance.
 *
 * Registered under the plugin's own namespace so no shipped dictionary is
 * touched, following the same pattern as `@deepseek-ai/dsh-client-ui-goal`.
 */

/** Dictionary namespace owned by this plugin. */
export const NS = 'retry-button'

/** English copy. */
export const en = {
  'action.retry': 'Retry',
  'action.retrying': 'Retrying…',
  'title.retry': 'Retry this request',
  'hint.retry': "Re-sends this turn's original message as a new turn.",
  'error.noMessage': 'No original message to resend.',
  'error.unavailable': 'The composer is not ready.',
} as const

/** Chinese copy. */
export const zh: Record<keyof typeof en, string> = {
  'action.retry': '重试',
  'action.retrying': '重试中…',
  'title.retry': '重试这次请求',
  'hint.retry': '会把本回合原本的消息作为新回合重新发送。',
  'error.noMessage': '找不到可以重发的原始消息。',
  'error.unavailable': '输入框当前不可用。',
}

/**
 * The locale key union this namespace contributes.
 *
 * The locale service types `register(ns, dicts)` against the merged
 * `LocaleNamespaceMap`, so the namespace must be declared here for the
 * two dictionaries to be checked as a complete, matching pair.
 */
export type RetryButtonKey = keyof typeof en

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Manual-retry affordance copy. */
    'retry-button': RetryButtonKey
  }
}