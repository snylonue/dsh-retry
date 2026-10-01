/**
 * Registration contract tests against the real slot registry.
 *
 * These exist because this plugin replaces an occupant the Chat package already
 * registered. A keyed slot rejects a second entry for the same `key` at the
 * same `priority`, and the default rank is 0 — so registering without an
 * explicit lower rank throws, `slots.inject` propagates that synchronously, and
 * the whole plugin fails activation with the bare message
 * `dsh-retry-button: failed`. That failure is invisible until a browser boots
 * the page, so it is asserted here instead.
 */

import { describe, expect, it } from 'vitest'
// eslint-disable-next-line
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'

/** The slot both rows register into. */
const KEY = 'conversation.chat.node'

/** Build a registry with the slot declared and the shipped occupant present. */
function registryWithShippedOccupant(): InstanceType<typeof SlotCore> {
  const core = new SlotCore()
  core.record(KEY).spec = { kind: 'keyed', scope: 'session' }
  core.record(KEY).declaredBy = 'factory "@deepseek-ai/dsh-client-ui-chat"'
  // The shipped turn-error renderer, registered at the default rank.
  core.register({ name: KEY, key: 'turn-error' }, () => null)
  return core
}

describe('slot registration', () => {
  it('rejects replacing the shipped turn-error row at the default priority', () => {
    // Documents the bug this plugin shipped with once: no explicit priority
    // collides with the shipped occupant.
    const core = registryWithShippedOccupant()
    expect(() => core.register({ name: KEY, key: 'turn-error' }, () => null)).toThrow(
      /already has an entry for key "turn-error"/,
    )
  })

  it('accepts replacing the shipped turn-error row at a lower priority', () => {
    const core = registryWithShippedOccupant()
    expect(() =>
      core.register({ name: KEY, key: 'turn-error', priority: -1 }, () => null),
    ).not.toThrow()
  })

  it('accepts the new turn-cancelled key at a lower priority', () => {
    const core = registryWithShippedOccupant()
    expect(() =>
      core.register({ name: KEY, key: 'turn-cancelled', priority: -1 }, () => null),
    ).not.toThrow()
  })

  it('makes the lower-priority entry the sole rendering winner', () => {
    const core = registryWithShippedOccupant()
    core.register({ name: KEY, key: 'turn-error', priority: -1 }, () => null)
    // `entriesOfSlot` projects each cell to its shadowing winner, so the
    // shadowed shipped entry is absent: exactly one occupant remains and it is
    // the plugin's.
    const winners = core.entriesOfSlot(KEY).filter((entry) => entry.options.key === 'turn-error')
    expect(winners.length).toBe(1)
    expect(winners[0]?.options.priority).toBe(-1)
  })
})