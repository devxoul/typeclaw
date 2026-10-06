import { describe, expect, test } from 'bun:test'

import {
  decideMemoryOversubscription,
  formatOversubscriptionWarning,
  parseAgentMemoryClaims,
} from './memory-oversubscription'

const GIB = 1024 * 1024 * 1024

describe('decideMemoryOversubscription', () => {
  test('stays quiet when the caps fit', () => {
    const result = decideMemoryOversubscription({
      running: [{ containerName: 'alpha', bytes: 6 * GIB }],
      incoming: { containerName: 'beta', bytes: 6 * GIB },
      totalMemoryBytes: 16 * GIB,
    })

    expect(result).toBeNull()
  })

  test('fires when every agent peaking together exceeds Docker memory', () => {
    // given three agents at 6GiB each on a 16GiB Docker VM
    const result = decideMemoryOversubscription({
      running: [
        { containerName: 'alpha', bytes: 6 * GIB },
        { containerName: 'beta', bytes: 6 * GIB },
      ],
      incoming: { containerName: 'gamma', bytes: 6 * GIB },
      totalMemoryBytes: 16 * GIB,
    })

    expect(result).not.toBeNull()
    expect(result?.claimedBytes).toBe(18 * GIB)
    expect(result?.claims).toHaveLength(3)
  })

  test('does not count a restarting agent twice', () => {
    // given the agent being started is already in the running list, which is
    // exactly what `typeclaw restart` looks like
    const result = decideMemoryOversubscription({
      running: [{ containerName: 'alpha', bytes: 10 * GIB }],
      incoming: { containerName: 'alpha', bytes: 10 * GIB },
      totalMemoryBytes: 16 * GIB,
    })

    expect(result).toBeNull()
  })

  test('checks an already-running fleet without an incoming agent', () => {
    // given compose's post-start check, where every agent is already listed
    const result = decideMemoryOversubscription({
      running: [
        { containerName: 'alpha', bytes: 6 * GIB },
        { containerName: 'beta', bytes: 6 * GIB },
        { containerName: 'gamma', bytes: 6 * GIB },
      ],
      totalMemoryBytes: 16 * GIB,
    })

    expect(result?.claimedBytes).toBe(18 * GIB)
    expect(result?.claims.map((claim) => claim.containerName)).toEqual(['alpha', 'beta', 'gamma'])
  })

  test('stays quiet when Docker memory is unknown and every agent is bounded', () => {
    // given no capacity figure, the arithmetic cannot be done and there is
    // nothing else to report
    const result = decideMemoryOversubscription({
      running: [{ containerName: 'alpha', bytes: 64 * GIB }],
      incoming: { containerName: 'beta', bytes: 64 * GIB },
      totalMemoryBytes: undefined,
    })

    expect(result).toBeNull()
  })

  test('still reports an unbounded agent when Docker memory is unknown', () => {
    // given an unreadable daemon total — now reachable in normal operation,
    // since the workstation-RAM fallback was removed — alongside a legacy
    // agent running with no limit at all
    const result = decideMemoryOversubscription({
      running: [{ containerName: 'legacy', bytes: null }],
      incoming: { containerName: 'beta', bytes: 6 * GIB },
      totalMemoryBytes: undefined,
    })

    // then it is still named: identifying it needs no capacity arithmetic
    expect(result).not.toBeNull()
    expect(result?.totalMemoryBytes).toBeNull()
    expect(result?.unbounded.map((c) => c.containerName)).toEqual(['legacy'])
  })

  test('says capacity is unknown rather than inventing a figure', () => {
    const lines = formatOversubscriptionWarning({
      claims: [{ containerName: 'legacy', bytes: null }],
      claimedBytes: 0,
      totalMemoryBytes: null,
      unbounded: [{ containerName: 'legacy', bytes: null }],
    })
    const text = lines.join('\n')

    expect(text).toContain('legacy')
    expect(text).toContain('no memory limit')
    expect(text).toContain('could not be read')
    expect(text).not.toContain('0.0GiB')
  })
})

describe('formatOversubscriptionWarning', () => {
  test('shows the arithmetic and every agent involved', () => {
    const lines = formatOversubscriptionWarning({
      claims: [
        { containerName: 'alpha', bytes: 6 * GIB },
        { containerName: 'beta', bytes: 6 * GIB },
      ],
      claimedBytes: 12 * GIB,
      totalMemoryBytes: 8 * GIB,
      unbounded: [],
    })
    const text = lines.join('\n')

    expect(text).toContain('12.0GiB')
    expect(text).toContain('8.0GiB')
    expect(text).toContain('alpha')
    expect(text).toContain('beta')
  })

  test('tells the operator how to act, per runtime, with a concrete size', () => {
    const lines = formatOversubscriptionWarning({
      claims: [
        { containerName: 'alpha', bytes: 6 * GIB },
        { containerName: 'beta', bytes: 6 * GIB },
      ],
      claimedBytes: 12 * GIB,
      totalMemoryBytes: 8 * GIB,
      unbounded: [],
    })
    const text = lines.join('\n')

    expect(text).toContain('typeclaw stop')
    expect(text).toContain('at least 14GiB')
    expect(text).toContain('Docker Desktop: Settings → Resources → Memory limit')
    expect(text).toContain('orb config set memory_mib 14336')
    expect(text).toContain('colima start --memory 14')
  })
})

describe('unbounded agents', () => {
  test('an agent running with no limit is reported even when the sum fits', () => {
    // given a pre-upgrade agent Docker reports as 0 (unlimited), alongside a
    // capped one that easily fits
    const result = decideMemoryOversubscription({
      running: [{ containerName: 'legacy', bytes: null }],
      incoming: { containerName: 'beta', bytes: 6 * GIB },
      totalMemoryBytes: 64 * GIB,
    })

    // then it must not be silently dropped from the roster: its ceiling is the
    // whole machine, so no arithmetic over the capped agents proves safety
    expect(result).not.toBeNull()
    expect(result?.unbounded.map((c) => c.containerName)).toEqual(['legacy'])
  })

  test('names the unbounded agent and its remedy rather than the arithmetic', () => {
    const lines = formatOversubscriptionWarning({
      claims: [
        { containerName: 'legacy', bytes: null },
        { containerName: 'beta', bytes: 6 * GIB },
      ],
      claimedBytes: 6 * GIB,
      totalMemoryBytes: 64 * GIB,
      unbounded: [{ containerName: 'legacy', bytes: null }],
    })
    const text = lines.join('\n')

    expect(text).toContain('legacy')
    expect(text).toContain('no memory limit')
    expect(text).toContain('unlimited')
    expect(text).toContain('Restart it')
  })
})

describe('parseAgentMemoryClaims', () => {
  test('reads names and applied limits from docker inspect output', () => {
    const claims = parseAgentMemoryClaims(['/alpha 6442450944', '/beta 4294967296'].join('\n'))

    expect(claims).toEqual([
      { containerName: 'alpha', bytes: 6442450944 },
      { containerName: 'beta', bytes: 4294967296 },
    ])
  })

  test('preserves an unlimited agent instead of dropping it', () => {
    // given an agent started before this field existed, docker reports 0 —
    // which means unlimited, not absent
    const claims = parseAgentMemoryClaims(['/alpha 0', '/beta 6442450944'].join('\n'))

    expect(claims).toEqual([
      { containerName: 'alpha', bytes: null },
      { containerName: 'beta', bytes: 6442450944 },
    ])
  })

  test('tolerates blank and malformed lines', () => {
    const claims = parseAgentMemoryClaims(['', '/alpha 6442450944', 'garbage', '   '].join('\n'))

    expect(claims).toEqual([{ containerName: 'alpha', bytes: 6442450944 }])
  })
})
