import { expect, test } from 'bun:test'

import { effectiveGhTokensForCommand } from './gh-command'
import { verifyReviewTokenAccount, type ReviewAccountFetch } from './review-account'

test('formal review authenticates command-local PAT rather than inherited account', async () => {
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const auth = request.headers.get('authorization')
      return Response.json({ id: auth === 'Bearer ghp_A' ? 1 : 2 })
    },
  })
  const fetchImpl: ReviewAccountFetch = (_input, init) => fetch(new URL('/user', server.url), init)
  try {
    const original = effectiveGhTokensForCommand('gh api /repos/acme/widgets/pulls/5/reviews -f event=COMMENT', {
      GH_TOKEN: 'ghp_A',
    })
    expect(await verifyReviewTokenAccount({ token: original[0], expectedAccountIdentity: 'github:1', fetchImpl })).toBe(
      true,
    )
    const rotated = effectiveGhTokensForCommand(
      'GH_TOKEN=ghp_B gh api /repos/acme/widgets/pulls/5/reviews -f event=COMMENT',
      { GH_TOKEN: 'ghp_A' },
    )
    expect(await verifyReviewTokenAccount({ token: rotated[0], expectedAccountIdentity: 'github:1', fetchImpl })).toBe(
      false,
    )
  } finally {
    await server.stop(true)
  }
})
