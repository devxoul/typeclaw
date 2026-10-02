import { describe, expect, it } from 'bun:test'

import { createGithubTokenBridge } from './github-token-bridge'

describe('createGithubTokenBridge', () => {
  it('in-flight resolver rotation preserves the credential actor pair', async () => {
    const bridge = createGithubTokenBridge()
    const release = Promise.withResolvers<void>()
    bridge.registerResolver(async () => {
      await release.promise
      return { token: 'ghs_A', accountIdentity: 'github:1' }
    })
    const pending = bridge.resolveTokenForRepo('acme/widgets')
    bridge.registerResolver(async () => ({ token: 'ghs_B', accountIdentity: 'github:2' }))
    release.resolve()
    expect(await pending).toEqual({ kind: 'token', token: 'ghs_A', accountIdentity: 'github:1' })
    expect(await bridge.resolveTokenForRepo('acme/widgets')).toEqual({
      kind: 'token',
      token: 'ghs_B',
      accountIdentity: 'github:2',
    })
  })
  it('returns unavailable when no resolver is registered', async () => {
    const bridge = createGithubTokenBridge()

    const result = await bridge.resolveTokenForRepo('acme/widgets')

    expect(result.kind).toBe('unavailable')
    if (result.kind === 'unavailable') expect(result.reason).toContain('not running')
  })

  it('surfaces a throwing resolver as unavailable instead of crashing', async () => {
    const bridge = createGithubTokenBridge()
    bridge.registerResolver(async () => {
      throw new Error('installation lookup failed: 404')
    })

    const result = await bridge.resolveTokenForRepo('acme/widgets')

    expect(result).toEqual({ kind: 'unavailable', reason: 'installation lookup failed: 404' })
  })

  it('unregister restores the unavailable state', async () => {
    const bridge = createGithubTokenBridge()
    const unregister = bridge.registerResolver(async () => ({ token: 'ghs_x' }))

    unregister()
    const result = await bridge.resolveTokenForRepo('acme/widgets')

    expect(result.kind).toBe('unavailable')
  })

  it('a later register replaces the current resolver', async () => {
    const bridge = createGithubTokenBridge()
    bridge.registerResolver(async () => ({ token: 'ghs_first' }))
    bridge.registerResolver(async () => ({ token: 'ghs_second' }))

    const result = await bridge.resolveTokenForRepo('acme/widgets')

    expect(result).toEqual({ kind: 'token', token: 'ghs_second' })
  })

  it('stale unregister does not wipe a newer resolver', async () => {
    const bridge = createGithubTokenBridge()
    const unregisterFirst = bridge.registerResolver(async () => ({ token: 'ghs_first' }))
    bridge.registerResolver(async () => ({ token: 'ghs_second' }))

    unregisterFirst()
    const result = await bridge.resolveTokenForRepo('acme/widgets')

    expect(result).toEqual({ kind: 'token', token: 'ghs_second' })
  })

  it('hasAppTokenResolver tracks resolver registration', () => {
    const bridge = createGithubTokenBridge()
    expect(bridge.hasAppTokenResolver()).toBe(false)

    const unregister = bridge.registerResolver(async () => ({ token: 'ghs_x' }))
    expect(bridge.hasAppTokenResolver()).toBe(true)

    unregister()
    expect(bridge.hasAppTokenResolver()).toBe(false)
  })

  it('carries adapter-resolved self login with the active App resolver', () => {
    const bridge = createGithubTokenBridge()
    const unregister = bridge.registerResolver(
      async () => ({ token: 'ghs_x' }),
      () => 'typeclaw[bot]',
    )

    expect(bridge.getAppSelfLogin()).toBe('typeclaw[bot]')
    unregister()
    expect(bridge.getAppSelfLogin()).toBeNull()
  })
})
