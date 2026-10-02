import { describe, expect, it } from 'bun:test'
import { createHmac } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { __resetReviewVerdictGuardForTest } from '@/channels/github-review-verdict-coordinator'
import { InboundJournal } from '@/channels/inbound-journal'
import { DEFAULT_GITHUB_EVENT_ALLOWLIST } from '@/channels/schema'
import type { InboundMessage } from '@/channels/types'

import { createDeliveryDedup } from './dedup'
import {
  classifyGithubInbound,
  createGithubWebhookHandler,
  type GithubWebhookHandlerOptions,
  PR_APPROVAL_DISABLED_NOTE,
  processVerifiedGithubDelivery,
  verifySignature,
} from './inbound'
import { decodeGithubReactionRef } from './reactions'

const logger = { info: () => {}, warn: () => {}, error: () => {} }

describe('verifySignature', () => {
  it('accepts the GitHub docs test vector', async () => {
    const ok = await verifySignature(
      'Hello, World!',
      "It's a Secret to Everybody",
      'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17',
    )
    expect(ok).toBe(true)
  })
})

describe('classifyGithubInbound', () => {
  it('keeps edited comments and review requests on different commits distinct', () => {
    const original = issueCommentPayload({ pullRequest: true, body: '@typeclaw-bot 확인해줘' })
    const edited = {
      ...original,
      action: 'edited',
      comment: { ...(original.comment as Record<string, unknown>), updated_at: '2026-01-02T00:00:00Z' },
    }
    const before = classifyGithubInbound('issue_comment', original, 'typeclaw-bot')
    const after = classifyGithubInbound('issue_comment', edited, 'typeclaw-bot')
    expect(after?.externalMessageId).toBe(before?.externalMessageId)
    expect(after?.eventKind).not.toBe(before?.eventKind)
    expect(after?.revision).not.toBe(before?.revision)
    const request = reviewRequestedPayload({ reviewerLogin: 'typeclaw-bot' })
    const pr = request.pull_request as Record<string, unknown>
    const first = classifyGithubInbound(
      'pull_request',
      { ...request, pull_request: { ...pr, head: { sha: 'commit-a' } } },
      'typeclaw-bot',
    )
    const second = classifyGithubInbound(
      'pull_request',
      { ...request, pull_request: { ...pr, head: { sha: 'commit-b' } } },
      'typeclaw-bot',
    )
    expect(first?.isBotMention).toBe(true)
    expect(second?.isBotMention).toBe(true)
    expect(second?.revision).not.toBe(first?.revision)
  })

  it('classifies issue comments on pull requests as PR chats', () => {
    const msg = classifyGithubInbound('issue_comment', issueCommentPayload({ pullRequest: true }), 'typeclaw-bot')
    expect(msg?.workspace).toBe('acme/project')
    expect(msg?.chat).toBe('pr:7')
    expect(msg?.thread).toBe(null)
    expect(msg?.authorName).toBe('alice')
  })

  it('classifies review comments into root-comment threads', () => {
    const msg = classifyGithubInbound('pull_request_review_comment', reviewCommentPayload(), 'typeclaw-bot')
    expect(msg?.chat).toBe('pr:7')
    expect(msg?.thread).toBe('101')
  })

  describe('PR review-thread explicit-only engagement fields', () => {
    it('marks a reply to the bot review comment as explicit-only and reply-to-bot', () => {
      const msg = classifyGithubInbound('pull_request_review_comment', reviewCommentPayload(), 'typeclaw-bot', {
        reviewCommentParent: { isSelf: true, parentId: 101 },
      })
      expect(msg?.replyToBotMessageId).toBe('101')
      expect(msg?.replyToOtherMessageId).toBe(null)
      expect(msg?.suppressSticky).toBe(true)
      expect(msg?.githubReviewThreadCloseout).toEqual({
        workspace: 'acme/project',
        prNumber: 7,
        rootCommentId: '101',
      })
    })

    it('marks a reply to someone else review comment as explicit-only and reply-to-other', () => {
      const msg = classifyGithubInbound('pull_request_review_comment', reviewCommentPayload(), 'typeclaw-bot', {
        reviewCommentParent: { isSelf: false, parentId: 101 },
      })
      expect(msg?.replyToBotMessageId).toBe(null)
      expect(msg?.replyToOtherMessageId).toBe('101')
      expect(msg?.suppressSticky).toBe(true)
      expect(msg?.githubReviewThreadCloseout).toBeUndefined()
    })

    it('does not stamp a closeout obligation on a peer-bot reply to the bot review comment', () => {
      const payload = reviewCommentPayload()
      ;(payload.comment as Record<string, unknown>).user = { login: 'peer-bot', id: 20, type: 'Bot' }

      const msg = classifyGithubInbound('pull_request_review_comment', payload, 'typeclaw-bot', {
        reviewCommentParent: { isSelf: true, parentId: 101 },
      })

      expect(msg?.authorIsBot).toBe(true)
      expect(msg?.replyToBotMessageId).toBe('101')
      expect(msg?.githubReviewThreadCloseout).toBeUndefined()
    })

    it('marks a top-level review comment as explicit-only without reply fields', () => {
      const msg = classifyGithubInbound(
        'pull_request_review_comment',
        reviewCommentPayload({ inReplyToId: null }),
        'typeclaw-bot',
      )
      expect(msg?.thread).toBe('102')
      expect(msg?.replyToBotMessageId).toBe(null)
      expect(msg?.replyToOtherMessageId).toBe(null)
      expect(msg?.suppressSticky).toBe(true)
      expect(msg?.githubReviewThreadCloseout).toBeUndefined()
    })

    it('preserves @mention detection on explicit-only review comments', () => {
      const msg = classifyGithubInbound(
        'pull_request_review_comment',
        reviewCommentPayload({ body: '@typeclaw-bot please look' }),
        'typeclaw-bot',
      )
      expect(msg?.isBotMention).toBe(true)
      expect(msg?.suppressSticky).toBe(true)
    })

    it('marks top-level submitted reviews as explicit-only without reply fields', () => {
      const msg = classifyGithubInbound(
        'pull_request_review',
        {
          action: 'submitted',
          repository: repo(),
          pull_request: { number: 7, id: 700, user: user() },
          review: { id: 5002, body: 'please fix', submitted_at: '2026-01-01T00:00:00Z', user: user() },
        },
        'typeclaw-bot',
      )
      expect(msg?.replyToBotMessageId).toBe(null)
      expect(msg?.replyToOtherMessageId).toBe(null)
      expect(msg?.suppressSticky).toBe(true)
    })

    it('leaves PR issue comments on normal engagement behavior', () => {
      const msg = classifyGithubInbound('issue_comment', issueCommentPayload({ pullRequest: true }), 'typeclaw-bot')
      expect(msg?.suppressSticky).toBeUndefined()
    })
  })

  describe('reactionRef stamping', () => {
    it('stamps an issue-comment ref for a comment on a PR (reacts to the comment, not the PR body)', () => {
      const msg = classifyGithubInbound('issue_comment', issueCommentPayload({ pullRequest: true }), 'typeclaw-bot')
      expect(decodeGithubReactionRef(msg!.reactionRef!)).toEqual({
        kind: 'issue-comment',
        owner: 'acme',
        repo: 'project',
        commentId: 99,
      })
    })

    it('stamps a pr-review-comment ref for an inline review comment', () => {
      const msg = classifyGithubInbound('pull_request_review_comment', reviewCommentPayload(), 'typeclaw-bot')
      expect(decodeGithubReactionRef(msg!.reactionRef!)).toEqual({
        kind: 'pr-review-comment',
        owner: 'acme',
        repo: 'project',
        commentId: 102,
      })
    })

    it('stamps an issue ref (by number) for an issue body', () => {
      const payload = {
        action: 'opened',
        repository: repo(),
        issue: { number: 7, id: 700, body: 'hi', created_at: '2026-01-01T00:00:00Z', user: user() },
      }
      const msg = classifyGithubInbound('issues', payload, 'typeclaw-bot')
      expect(decodeGithubReactionRef(msg!.reactionRef!)).toEqual({
        kind: 'issue',
        owner: 'acme',
        repo: 'project',
        issueNumber: 7,
      })
    })

    it('stamps an issue ref (by PR number) for a PR body — PR bodies react via the issues endpoint', () => {
      const payload = {
        action: 'opened',
        repository: repo(),
        pull_request: { number: 7, id: 700, body: 'hi', created_at: '2026-01-01T00:00:00Z', user: user() },
      }
      const msg = classifyGithubInbound('pull_request', payload, 'typeclaw-bot')
      expect(decodeGithubReactionRef(msg!.reactionRef!)).toEqual({
        kind: 'issue',
        owner: 'acme',
        repo: 'project',
        issueNumber: 7,
      })
    })

    it('omits reactionRef for events with no standard reactions endpoint (review, discussion)', () => {
      const review = classifyGithubInbound(
        'pull_request_review',
        {
          action: 'submitted',
          repository: repo(),
          pull_request: { number: 7, id: 700, user: user() },
          review: { id: 5002, body: 'lgtm', submitted_at: '2026-01-01T00:00:00Z', user: user() },
        },
        'typeclaw-bot',
      )
      expect(review?.reactionRef).toBeUndefined()
    })

    it('omits reactionRef on synthetic review-request inbounds', () => {
      const msg = classifyGithubInbound(
        'pull_request',
        reviewRequestedPayload({ reviewerLogin: 'typeclaw-bot' }),
        'typeclaw-bot',
      )
      expect(msg?.text).toContain('requested your review')
      expect(msg?.reactionRef).toBeUndefined()
    })
  })

  // Regression: under GitHub App auth selfLogin is the actor login `slug[bot]`,
  // but a human mentions the App by its bare slug `@slug` (the decoy account).
  // The classifier must recognize the bare-slug mention or a direct
  // "@typeey review again" lands with isBotMention=false and the engagement
  // mention gate never fires (the comment is silently observed/dropped).
  describe('isBotMention decoy-aware detection (App auth)', () => {
    it('recognizes a bare-slug @mention of an App bot whose actor login is slug[bot]', () => {
      const msg = classifyGithubInbound(
        'issue_comment',
        issueCommentPayload({ pullRequest: true, body: '@typeclaw review again' }),
        'typeclaw[bot]',
        { authType: 'app' },
      )
      expect(msg?.isBotMention).toBe(true)
    })

    it('still recognizes the full slug[bot] @mention under App auth', () => {
      const msg = classifyGithubInbound(
        'issue_comment',
        issueCommentPayload({ pullRequest: true, body: '@typeclaw[bot] review again' }),
        'typeclaw[bot]',
        { authType: 'app' },
      )
      expect(msg?.isBotMention).toBe(true)
    })

    it('does not flag an unrelated @mention as a self-mention under App auth', () => {
      const msg = classifyGithubInbound(
        'issue_comment',
        issueCommentPayload({ pullRequest: true, body: '@someone-else take a look' }),
        'typeclaw[bot]',
        { authType: 'app' },
      )
      expect(msg?.isBotMention).toBe(false)
    })

    it('does not treat a longer login sharing the decoy-slug prefix as a self-mention', () => {
      // The decoy slug for `typeclaw[bot]` is `typeclaw`; `@typeclaw-bot` is a
      // DIFFERENT GitHub user. A substring check would false-positive here, so
      // the matcher must respect GitHub-login boundaries (- is a login char).
      const msg = classifyGithubInbound(
        'issue_comment',
        issueCommentPayload({ pullRequest: true, body: '@typeclaw-bot can you review?' }),
        'typeclaw[bot]',
        { authType: 'app' },
      )
      expect(msg?.isBotMention).toBe(false)
    })

    it('does not derive a decoy slug under PAT auth (only the real login mentions)', () => {
      // PAT bots are real users requested by their actual login; there is no
      // decoy slug, so a bare-prefix collision must not register as a mention.
      const hit = classifyGithubInbound(
        'issue_comment',
        issueCommentPayload({ pullRequest: true, body: '@typeclaw review again' }),
        'typeclaw-bot',
        { authType: 'pat' },
      )
      expect(hit?.isBotMention).toBe(false)

      const realMention = classifyGithubInbound(
        'issue_comment',
        issueCommentPayload({ pullRequest: true, body: '@typeclaw-bot review again' }),
        'typeclaw-bot',
        { authType: 'pat' },
      )
      expect(realMention?.isBotMention).toBe(true)
    })
  })

  describe('pull_request.review_requested', () => {
    it('wakes the bot when it is the requested reviewer', () => {
      const msg = classifyGithubInbound(
        'pull_request',
        reviewRequestedPayload({ reviewerLogin: 'typeclaw-bot' }),
        'typeclaw-bot',
      )
      expect(msg?.chat).toBe('pr:7')
      expect(msg?.thread).toBe(null)
      expect(msg?.text).toContain('@alice')
      expect(msg?.text).toContain('requested your review on PR #7')
      expect(msg?.text).toContain('feat-branch → main')
      expect(msg?.text).toContain('Please review the changes line-by-line')
      expect(msg?.isBotMention).toBe(true)
      expect(msg?.authorName).toBe('alice')
    })

    it('drops requests targeting someone else', () => {
      const msg = classifyGithubInbound(
        'pull_request',
        reviewRequestedPayload({ reviewerLogin: 'someone-else' }),
        'typeclaw-bot',
      )
      expect(msg).toBe(null)
    })

    it('drops self-loop when the bot requested itself', () => {
      const payload = reviewRequestedPayload({ reviewerLogin: 'typeclaw-bot' })
      ;(payload.sender as Record<string, unknown>).login = 'typeclaw-bot'
      const msg = classifyGithubInbound('pull_request', payload, 'typeclaw-bot')
      expect(msg).toBe(null)
    })

    it('wakes the bot when its team is requested and membership resolves true', () => {
      const msg = classifyGithubInbound('pull_request', reviewRequestedTeamPayload(), 'typeclaw-bot', {
        teamIsBotMember: true,
      })
      expect(msg?.chat).toBe('pr:7')
      expect(msg?.text).toContain("team @reviewers (you're a member of)")
    })

    it('drops team requests when membership resolves false', () => {
      const msg = classifyGithubInbound('pull_request', reviewRequestedTeamPayload(), 'typeclaw-bot', {
        teamIsBotMember: false,
      })
      expect(msg).toBe(null)
    })

    it('drops team requests when membership is unknown (handler did not resolve)', () => {
      const msg = classifyGithubInbound('pull_request', reviewRequestedTeamPayload(), 'typeclaw-bot')
      expect(msg).toBe(null)
    })

    it('mints distinct externalMessageIds for requested → removed → requested again', () => {
      const requested = classifyGithubInbound(
        'pull_request',
        reviewRequestedPayload({ reviewerLogin: 'typeclaw-bot', updatedAt: '2026-01-01T00:00:00Z' }),
        'typeclaw-bot',
      )
      const removed = classifyGithubInbound(
        'pull_request',
        reviewRequestRemovedPayload({ reviewerLogin: 'typeclaw-bot', updatedAt: '2026-01-01T00:01:00Z' }),
        'typeclaw-bot',
      )
      const requestedAgain = classifyGithubInbound(
        'pull_request',
        reviewRequestedPayload({ reviewerLogin: 'typeclaw-bot', updatedAt: '2026-01-01T00:02:00Z' }),
        'typeclaw-bot',
      )
      expect(requested?.externalMessageId).not.toBe(removed?.externalMessageId)
      expect(removed?.externalMessageId).not.toBe(requestedAgain?.externalMessageId)
      expect(requested?.externalMessageId).not.toBe(requestedAgain?.externalMessageId)
    })

    it('falls back to PR id when title/branch info is absent', () => {
      const payload = reviewRequestedPayload({ reviewerLogin: 'typeclaw-bot' })
      delete (payload.pull_request as Record<string, unknown>).title
      delete (payload.pull_request as Record<string, unknown>).head
      delete (payload.pull_request as Record<string, unknown>).base
      const msg = classifyGithubInbound('pull_request', payload, 'typeclaw-bot')
      expect(msg?.text).toContain('PR #7')
      expect(msg?.text).not.toContain('Branch:')
    })
  })

  describe('pull_request.review_request_removed', () => {
    it('emits a cleanup signal when the bot is un-requested', () => {
      const msg = classifyGithubInbound(
        'pull_request',
        reviewRequestRemovedPayload({ reviewerLogin: 'typeclaw-bot' }),
        'typeclaw-bot',
      )
      expect(msg?.chat).toBe('pr:7')
      expect(msg?.text).toContain('removed your review request')
      expect(msg?.text).toContain('You can stop any in-progress review.')
    })

    it('drops removal events for other reviewers', () => {
      const msg = classifyGithubInbound(
        'pull_request',
        reviewRequestRemovedPayload({ reviewerLogin: 'someone-else' }),
        'typeclaw-bot',
      )
      expect(msg).toBe(null)
    })
  })

  describe('pull_request.review_requested — App decoy reviewer', () => {
    // In App mode selfLogin is the bot actor `slug[bot]`, which can never appear
    // as a requested_reviewer. The decoy account named after the App (login =
    // slug, here `typeclaw`) is what an operator actually requests.
    it('wakes the App when the decoy (slug) account is requested', () => {
      const msg = classifyGithubInbound(
        'pull_request',
        reviewRequestedPayload({ reviewerLogin: 'typeclaw' }),
        'typeclaw[bot]',
        { authType: 'app' },
      )
      expect(msg?.chat).toBe('pr:7')
      expect(msg?.text).toContain('requested your review on PR #7')
      expect(msg?.isBotMention).toBe(true)
    })

    it('still wakes the App when the exact slug[bot] login is requested', () => {
      const msg = classifyGithubInbound(
        'pull_request',
        reviewRequestedPayload({ reviewerLogin: 'typeclaw[bot]' }),
        'typeclaw[bot]',
        { authType: 'app' },
      )
      expect(msg?.isBotMention).toBe(true)
    })

    it('drops decoy requests targeting an unrelated user', () => {
      const msg = classifyGithubInbound(
        'pull_request',
        reviewRequestedPayload({ reviewerLogin: 'someone-else' }),
        'typeclaw[bot]',
        { authType: 'app' },
      )
      expect(msg).toBe(null)
    })

    it('does NOT treat the slug as self in PAT mode', () => {
      // PAT auth has no decoy: the bot is a real user requested by its exact
      // login. A bare `typeclaw` reviewer must not match a `typeclaw[bot]` self.
      const msg = classifyGithubInbound(
        'pull_request',
        reviewRequestedPayload({ reviewerLogin: 'typeclaw' }),
        'typeclaw[bot]',
        { authType: 'pat' },
      )
      expect(msg).toBe(null)
    })

    it('drops self-loop when the decoy account requested the review itself', () => {
      const payload = reviewRequestedPayload({ reviewerLogin: 'typeclaw' })
      ;(payload.sender as Record<string, unknown>).login = 'typeclaw'
      const msg = classifyGithubInbound('pull_request', payload, 'typeclaw[bot]', { authType: 'app' })
      expect(msg).toBe(null)
    })
  })

  describe('pull_request.opened', () => {
    it('lands an opened PR as awareness-only context in App mode, not a review request', () => {
      // Reviews fire only on review_requested now — including for an App, via
      // its decoy reviewer (see the decoy-reviewer describe above). An opened
      // PR is plain context regardless of auth, so the agent does not review
      // every PR the moment it opens.
      const msg = classifyGithubInbound('pull_request', openedPayload(), 'typeclaw-bot', { authType: 'app' })
      expect(msg?.chat).toBe('pr:7')
      expect(msg?.text).not.toContain('requested your review')
      expect(msg?.text).not.toContain('Please review the changes line-by-line')
      expect(msg?.isBotMention).toBe(false)
    })

    it('lands an opened PR as awareness-only context in PAT mode', () => {
      const msg = classifyGithubInbound('pull_request', openedPayload(), 'typeclaw-bot', { authType: 'pat' })
      expect(msg?.chat).toBe('pr:7')
      expect(msg?.text).not.toContain('requested your review')
      expect(msg?.isBotMention).toBe(false)
    })

    it('lands an opened PR as awareness-only context when authType is unset', () => {
      const msg = classifyGithubInbound('pull_request', openedPayload(), 'typeclaw-bot')
      expect(msg?.text).not.toContain('requested your review')
      expect(msg?.isBotMention).toBe(false)
    })
  })

  describe('review.on gating', () => {
    it('defaults to review_requested when reviewOn is omitted: opened stays awareness-only', () => {
      const msg = classifyGithubInbound('pull_request', openedPayload(), 'typeclaw-bot')
      expect(msg?.isBotMention).toBe(false)
      expect(msg?.text).not.toContain('Please review the changes line-by-line')
    })

    it('defaults to review_requested when reviewOn is omitted: review_requested triggers a review', () => {
      const msg = classifyGithubInbound(
        'pull_request',
        reviewRequestedPayload({ reviewerLogin: 'typeclaw-bot' }),
        'typeclaw-bot',
      )
      expect(msg?.isBotMention).toBe(true)
      expect(msg?.text).toContain('requested your review on PR #7')
    })

    it('review_requested on a draft PR triggers a review under the default config', () => {
      const msg = classifyGithubInbound(
        'pull_request',
        reviewRequestedPayload({ reviewerLogin: 'typeclaw-bot', draft: true }),
        'typeclaw-bot',
      )
      expect(msg?.isBotMention).toBe(true)
      expect(msg?.text).toContain('requested your review on PR #7')
    })

    describe("reviewOn: 'opened'", () => {
      it('synthesizes a review trigger for an opened PR', () => {
        const msg = classifyGithubInbound('pull_request', openedPayload(), 'typeclaw-bot', { reviewOn: 'opened' })
        expect(msg?.chat).toBe('pr:7')
        expect(msg?.text).toContain('@alice opened PR #7: "Add the thing"')
        expect(msg?.text).toContain('feat-branch → main')
        expect(msg?.text).toContain('Please review the changes line-by-line and post your feedback.')
        expect(msg?.isBotMention).toBe(true)
        expect(msg?.authorName).toBe('alice')
      })

      it('falls back to PR id and omits the branch when title/branch info is absent', () => {
        const payload = openedPayload()
        delete (payload.pull_request as Record<string, unknown>).title
        delete (payload.pull_request as Record<string, unknown>).head
        delete (payload.pull_request as Record<string, unknown>).base
        const msg = classifyGithubInbound('pull_request', payload, 'typeclaw-bot', { reviewOn: 'opened' })
        expect(msg?.text).toContain('opened PR #7')
        expect(msg?.text).not.toContain('Branch:')
      })

      it('still triggers a review on an explicit review_requested (opened is a superset)', () => {
        const msg = classifyGithubInbound(
          'pull_request',
          reviewRequestedPayload({ reviewerLogin: 'typeclaw-bot' }),
          'typeclaw-bot',
          { reviewOn: 'opened' },
        )
        expect(msg?.isBotMention).toBe(true)
        expect(msg?.text).toContain('requested your review on PR #7')
      })

      it('skips a draft PR cleanly (null), deferring to the ready_for_review trigger', () => {
        const msg = classifyGithubInbound('pull_request', openedPayload({ draft: true }), 'typeclaw-bot', {
          reviewOn: 'opened',
        })
        expect(msg).toBe(null)
      })

      it('still auto-reviews when draft is explicitly false', () => {
        const msg = classifyGithubInbound('pull_request', openedPayload({ draft: false }), 'typeclaw-bot', {
          reviewOn: 'opened',
        })
        expect(msg?.isBotMention).toBe(true)
        expect(msg?.text).toContain('Please review the changes line-by-line')
      })

      it('still triggers on an explicit review_requested even when the PR is a draft', () => {
        const msg = classifyGithubInbound(
          'pull_request',
          reviewRequestedPayload({ reviewerLogin: 'typeclaw-bot', draft: true }),
          'typeclaw-bot',
          { reviewOn: 'opened' },
        )
        expect(msg?.isBotMention).toBe(true)
        expect(msg?.text).toContain('requested your review on PR #7')
      })

      it('reviews a skipped draft once it turns ready (ready_for_review fires on the draft→ready transition)', () => {
        const msg = classifyGithubInbound('pull_request', readyForReviewPayload(), 'typeclaw-bot', {
          reviewOn: 'opened',
        })
        expect(msg?.isBotMention).toBe(true)
        expect(msg?.text).toContain('Please review the changes line-by-line')
      })

      it('suppresses the review trigger when the bot opened its own PR (handler drops the self-authored event)', () => {
        const payload = openedPayload()
        ;(payload.sender as Record<string, unknown>).login = 'typeclaw-bot'
        ;(payload.pull_request as Record<string, unknown>).user = { login: 'typeclaw-bot', id: 99, type: 'Bot' }
        const msg = classifyGithubInbound('pull_request', payload, 'typeclaw-bot', { reviewOn: 'opened' })
        expect(msg?.isBotMention).toBe(false)
        expect(msg?.text).not.toContain('Please review the changes line-by-line')
      })

      it('suppresses the review trigger when the App decoy opened the PR', () => {
        const payload = openedPayload()
        ;(payload.sender as Record<string, unknown>).login = 'typeclaw'
        ;(payload.pull_request as Record<string, unknown>).user = { login: 'typeclaw', id: 42, type: 'User' }
        const msg = classifyGithubInbound('pull_request', payload, 'typeclaw[bot]', {
          reviewOn: 'opened',
          authType: 'app',
        })
        expect(msg?.isBotMention).toBe(false)
        expect(msg?.text).not.toContain('Please review the changes line-by-line')
      })
    })

    describe('pull_request.ready_for_review (treated as opened)', () => {
      it("synthesizes a review trigger when reviewOn is 'opened'", () => {
        const msg = classifyGithubInbound('pull_request', readyForReviewPayload(), 'typeclaw-bot', {
          reviewOn: 'opened',
        })
        expect(msg?.chat).toBe('pr:7')
        expect(msg?.text).toContain('@alice opened PR #7: "Add the thing"')
        expect(msg?.text).toContain('Please review the changes line-by-line and post your feedback.')
        expect(msg?.isBotMention).toBe(true)
        expect(msg?.authorName).toBe('alice')
      })

      it('stays awareness-only when reviewOn defaults to review_requested', () => {
        const msg = classifyGithubInbound('pull_request', readyForReviewPayload(), 'typeclaw-bot')
        expect(msg?.chat).toBe('pr:7')
        expect(msg?.isBotMention).toBe(false)
        expect(msg?.text).not.toContain('Please review the changes line-by-line')
      })

      it("stays awareness-only when reviewOn is 'off'", () => {
        const msg = classifyGithubInbound('pull_request', readyForReviewPayload(), 'typeclaw-bot', {
          reviewOn: 'off',
        })
        expect(msg?.chat).toBe('pr:7')
        expect(msg?.isBotMention).toBe(false)
        expect(msg?.text).not.toContain('Please review the changes line-by-line')
      })

      it('suppresses the review trigger when the bot marked its own PR ready', () => {
        const payload = readyForReviewPayload()
        ;(payload.sender as Record<string, unknown>).login = 'typeclaw-bot'
        ;(payload.pull_request as Record<string, unknown>).user = { login: 'typeclaw-bot', id: 99, type: 'Bot' }
        const msg = classifyGithubInbound('pull_request', payload, 'typeclaw-bot', { reviewOn: 'opened' })
        expect(msg?.isBotMention).toBe(false)
        expect(msg?.text).not.toContain('Please review the changes line-by-line')
      })
    })

    describe("reviewOn: 'off'", () => {
      it('drops a review_requested event entirely', () => {
        const msg = classifyGithubInbound(
          'pull_request',
          reviewRequestedPayload({ reviewerLogin: 'typeclaw-bot' }),
          'typeclaw-bot',
          { reviewOn: 'off' },
        )
        expect(msg).toBe(null)
      })

      it('drops a review_request_removed event entirely', () => {
        const msg = classifyGithubInbound(
          'pull_request',
          reviewRequestRemovedPayload({ reviewerLogin: 'typeclaw-bot' }),
          'typeclaw-bot',
          { reviewOn: 'off' },
        )
        expect(msg).toBe(null)
      })

      it('leaves an opened PR as awareness-only context (review trigger suppressed, engagement untouched)', () => {
        const msg = classifyGithubInbound('pull_request', openedPayload(), 'typeclaw-bot', { reviewOn: 'off' })
        expect(msg?.chat).toBe('pr:7')
        expect(msg?.isBotMention).toBe(false)
        expect(msg?.text).not.toContain('Please review the changes line-by-line')
      })
    })
  })
})

describe('classifyGithubInbound — review traffic on the bot-authored PR engages', () => {
  // Regression: a peer reviewer (human or bot) reviewing the bot's OWN PR is
  // directed at the bot — the inverse of review_requested — but review traffic
  // is explicit-only (suppressSticky) and never @mentions the bot, so it was
  // silently observed and the bot could not address the review. Self-PR review
  // traffic must force the engagement trigger while staying sticky-free, so
  // reviews on OTHER people's PRs remain observe-only (the PR #672 fix).
  function reviewOnSelfPr(
    reviewer: Record<string, unknown>,
    state = 'COMMENTED',
    body = 'take a look at this',
  ): Record<string, unknown> {
    return {
      action: 'submitted',
      repository: repo(),
      pull_request: {
        number: 7,
        id: 700,
        title: 'Add the thing',
        user: { login: 'typeclaw-bot', id: 99, type: 'Bot' },
      },
      review: { id: 5002, body, state, submitted_at: '2026-01-01T00:00:00Z', user: reviewer },
    }
  }

  it('engages a peer-bot review on the bot-authored PR', () => {
    const msg = classifyGithubInbound(
      'pull_request_review',
      reviewOnSelfPr({ login: 'peer-bot', id: 20, type: 'Bot' }),
      'typeclaw-bot',
    )
    expect(msg?.isBotMention).toBe(true)
    expect(msg?.suppressSticky).toBe(true)
    expect(msg?.authorName).toBe('peer-bot')
  })

  it('engages a human review on the bot-authored PR', () => {
    const msg = classifyGithubInbound('pull_request_review', reviewOnSelfPr(user()), 'typeclaw-bot')
    expect(msg?.isBotMention).toBe(true)
  })

  it('drops a body-less COMMENTED review on the bot-authored PR (inline-reply container, no thanks churn)', () => {
    const msg = classifyGithubInbound(
      'pull_request_review',
      reviewOnSelfPr({ login: 'peer-bot', id: 20, type: 'Bot' }, 'COMMENTED', ''),
      'typeclaw-bot',
    )
    expect(msg).toBe(null)
  })

  it('keeps a review on someone else PR observe-only (no forced mention)', () => {
    const payload = reviewOnSelfPr({ login: 'peer-bot', id: 20, type: 'Bot' })
    ;(payload.pull_request as Record<string, unknown>).user = user()
    const msg = classifyGithubInbound('pull_request_review', payload, 'typeclaw-bot')
    expect(msg?.isBotMention).toBe(false)
  })

  it('does not force-engage an APPROVED review on the bot PR (no thanks churn)', () => {
    const msg = classifyGithubInbound(
      'pull_request_review',
      reviewOnSelfPr({ login: 'peer-bot', id: 20, type: 'Bot' }, 'APPROVED'),
      'typeclaw-bot',
    )
    expect(msg?.isBotMention).toBe(false)
  })

  it('engages a CHANGES_REQUESTED review on the bot PR', () => {
    const msg = classifyGithubInbound(
      'pull_request_review',
      reviewOnSelfPr({ login: 'peer-bot', id: 20, type: 'Bot' }, 'CHANGES_REQUESTED'),
      'typeclaw-bot',
    )
    expect(msg?.isBotMention).toBe(true)
  })

  it('recognizes the bot PR via the App decoy slug', () => {
    const payload = reviewOnSelfPr({ login: 'peer-bot', id: 20, type: 'Bot' })
    ;(payload.pull_request as Record<string, unknown>).user = { login: 'typeclaw', id: 42, type: 'User' }
    const msg = classifyGithubInbound('pull_request_review', payload, 'typeclaw[bot]', { authType: 'app' })
    expect(msg?.isBotMention).toBe(true)
  })

  it('engages a top-level review comment on the bot-authored PR', () => {
    const payload = reviewCommentPayload({ inReplyToId: null })
    ;(payload.pull_request as Record<string, unknown>) = {
      number: 7,
      user: { login: 'typeclaw-bot', id: 99, type: 'Bot' },
    }
    const msg = classifyGithubInbound('pull_request_review_comment', payload, 'typeclaw-bot')
    expect(msg?.isBotMention).toBe(true)
    expect(msg?.suppressSticky).toBe(true)
  })

  it('keeps a top-level review comment on someone else PR observe-only', () => {
    const payload = reviewCommentPayload({ inReplyToId: null })
    ;(payload.pull_request as Record<string, unknown>) = { number: 7, user: user() }
    const msg = classifyGithubInbound('pull_request_review_comment', payload, 'typeclaw-bot')
    expect(msg?.isBotMention).toBe(false)
  })

  it('leaves a reply to another reviewer on the bot PR observe-only (reply-target wins)', () => {
    const payload = reviewCommentPayload({ inReplyToId: 101 })
    ;(payload.pull_request as Record<string, unknown>) = {
      number: 7,
      user: { login: 'typeclaw-bot', id: 99, type: 'Bot' },
    }
    const msg = classifyGithubInbound('pull_request_review_comment', payload, 'typeclaw-bot', {
      reviewCommentParent: { isSelf: false, parentId: 101 },
    })
    expect(msg?.isBotMention).toBe(false)
    expect(msg?.replyToOtherMessageId).toBe('101')
  })
})

describe('classifyGithubInbound — empty-body handling', () => {
  it('drops a pull_request_review_comment with an empty body', () => {
    const payload = reviewCommentPayload()
    ;(payload.comment as Record<string, unknown>).body = ''
    expect(classifyGithubInbound('pull_request_review_comment', payload, 'typeclaw-bot')).toBe(null)
  })

  it('drops an issue_comment with a whitespace-only body', () => {
    const payload = issueCommentPayload({ pullRequest: true })
    ;(payload.comment as Record<string, unknown>).body = '   \n  '
    expect(classifyGithubInbound('issue_comment', payload, 'typeclaw-bot')).toBe(null)
  })

  describe('pull_request_review.submitted with empty body', () => {
    const reviewSubmitted = (state: string, body = ''): Record<string, unknown> => ({
      action: 'submitted',
      repository: repo(),
      pull_request: { number: 7, id: 700, title: 'Add the thing', user: user() },
      review: { id: 5002, body, state, submitted_at: '2026-01-01T00:00:00Z', user: user() },
    })

    it('synthesizes neutral text from an APPROVED state', () => {
      const msg = classifyGithubInbound('pull_request_review', reviewSubmitted('APPROVED'), 'typeclaw-bot')
      expect(msg?.text).toBe('@alice approved PR #7: "Add the thing".')
      expect(msg?.isBotMention).toBe(false)
    })

    it('synthesizes neutral text from a CHANGES_REQUESTED state', () => {
      const msg = classifyGithubInbound('pull_request_review', reviewSubmitted('CHANGES_REQUESTED'), 'typeclaw-bot')
      expect(msg?.text).toBe('@alice requested changes on PR #7: "Add the thing".')
    })

    it('drops a body-less COMMENTED review (inline-reply container delivered as separate comment events)', () => {
      const msg = classifyGithubInbound('pull_request_review', reviewSubmitted('COMMENTED'), 'typeclaw-bot')
      expect(msg).toBe(null)
    })

    it('drops a body-less COMMENTED review case-insensitively (lowercase state from webhook payloads)', () => {
      const msg = classifyGithubInbound('pull_request_review', reviewSubmitted('commented'), 'typeclaw-bot')
      expect(msg).toBe(null)
    })

    it('matches the state case-insensitively (REST returns uppercase, some payloads lowercase)', () => {
      const upper = classifyGithubInbound('pull_request_review', reviewSubmitted('APPROVED'), 'typeclaw-bot')
      const lower = classifyGithubInbound('pull_request_review', reviewSubmitted('approved'), 'typeclaw-bot')
      expect(lower?.text).toBe(upper?.text)
      expect(lower?.text).toBe('@alice approved PR #7: "Add the thing".')
    })

    it('keeps the real body when the review has one', () => {
      const msg = classifyGithubInbound(
        'pull_request_review',
        reviewSubmitted('COMMENTED', 'looks good'),
        'typeclaw-bot',
      )
      expect(msg?.text).toBe('looks good')
    })
  })

  describe('body-less opened events synthesize a title line', () => {
    it('issues.opened with no body', () => {
      const payload = {
        action: 'opened',
        repository: repo(),
        issue: {
          number: 7,
          id: 700,
          title: 'Broken login',
          body: '',
          created_at: '2026-01-01T00:00:00Z',
          user: user(),
        },
      }
      const msg = classifyGithubInbound('issues', payload, 'typeclaw-bot')
      expect(msg?.text).toBe('@alice opened issue #7: "Broken login".')
      expect(msg?.isBotMention).toBe(false)
    })

    it('pull_request.opened with no body (awareness fallthrough, reviewOn defaults to review_requested)', () => {
      const payload = {
        action: 'opened',
        repository: repo(),
        pull_request: {
          number: 7,
          id: 700,
          title: 'Add the thing',
          body: '',
          created_at: '2026-01-01T00:00:00Z',
          user: user(),
        },
      }
      const msg = classifyGithubInbound('pull_request', payload, 'typeclaw-bot')
      expect(msg?.text).toBe('@alice opened PR #7: "Add the thing".')
    })

    it('discussion.created with no body', () => {
      const payload = {
        action: 'created',
        repository: repo(),
        discussion: {
          number: 7,
          id: 700,
          title: 'RFC: caching',
          body: '',
          created_at: '2026-01-01T00:00:00Z',
          user: user(),
        },
      }
      const msg = classifyGithubInbound('discussion', payload, 'typeclaw-bot')
      expect(msg?.text).toBe('@alice opened discussion #7: "RFC: caching".')
    })
  })

  it('drops a non-opened pull_request action with an empty body (e.g. edited)', () => {
    const payload = {
      action: 'edited',
      repository: repo(),
      pull_request: {
        number: 7,
        id: 700,
        title: 'Add the thing',
        body: '',
        created_at: '2026-01-01T00:00:00Z',
        user: user(),
      },
    }
    expect(classifyGithubInbound('pull_request', payload, 'typeclaw-bot')).toBe(null)
  })

  it('drops a non-opened issues action with an empty body (only issues.opened synthesizes a title)', () => {
    const payload = {
      action: 'edited',
      repository: repo(),
      issue: { number: 7, id: 700, title: 'Broken login', body: '', created_at: '2026-01-01T00:00:00Z', user: user() },
    }
    expect(classifyGithubInbound('issues', payload, 'typeclaw-bot')).toBe(null)
  })

  it('still routes review_requested through the synthesized review trigger (not affected by the empty-body drop)', () => {
    const msg = classifyGithubInbound(
      'pull_request',
      reviewRequestedPayload({ reviewerLogin: 'typeclaw-bot' }),
      'typeclaw-bot',
    )
    expect(msg?.isBotMention).toBe(true)
    expect(msg?.text).toContain('requested your review on PR #7')
  })
})

describe('createGithubWebhookHandler — review.on wiring', () => {
  const baseOptions = (routed: InboundMessage[], reviewOn?: () => 'review_requested' | 'opened' | 'off') => ({
    webhookSecret: 'secret',
    dedup: createDeliveryDedup(),
    allowlist: () => ['pull_request.opened', 'pull_request.review_requested'],
    selfId: () => '99',
    selfLogin: () => 'typeclaw-bot',
    logger,
    route: async (msg: InboundMessage) => {
      routed.push(msg)
      return { kind: 'observed' as const }
    },
    ...(reviewOn !== undefined ? { reviewOn } : {}),
  })

  it("routes an opened PR as a review trigger when reviewOn is 'opened'", async () => {
    const routed: InboundMessage[] = []
    const handler = createGithubWebhookHandler(baseOptions(routed, () => 'opened'))
    await handler(signedRequest(JSON.stringify(openedPayload()), 'pull_request', 'on-opened-1'))
    expect(routed).toHaveLength(1)
    expect(routed[0]?.isBotMention).toBe(true)
    expect(routed[0]?.text).toContain('Please review the changes line-by-line')
  })

  it("drops a review_requested event when reviewOn is 'off'", async () => {
    const routed: InboundMessage[] = []
    const handler = createGithubWebhookHandler(baseOptions(routed, () => 'off'))
    await handler(
      signedRequest(
        JSON.stringify(reviewRequestedPayload({ reviewerLogin: 'typeclaw-bot' })),
        'pull_request',
        'on-off-1',
      ),
    )
    expect(routed).toHaveLength(0)
  })

  it('preserves request-driven behavior when reviewOn is omitted', async () => {
    const routed: InboundMessage[] = []
    const handler = createGithubWebhookHandler(baseOptions(routed))
    await handler(signedRequest(JSON.stringify(openedPayload()), 'pull_request', 'on-default-1'))
    expect(routed).toHaveLength(1)
    expect(routed[0]?.isBotMention).toBe(false)
  })

  it("admits a ready_for_review delivery under the default allowlist and routes it as a review trigger when reviewOn is 'opened'", async () => {
    const routed: InboundMessage[] = []
    const handler = createGithubWebhookHandler({
      ...baseOptions(routed, () => 'opened'),
      allowlist: () => [...DEFAULT_GITHUB_EVENT_ALLOWLIST],
    })
    await handler(signedRequest(JSON.stringify(readyForReviewPayload()), 'pull_request', 'on-rfr-1'))
    expect(routed).toHaveLength(1)
    expect(routed[0]?.isBotMention).toBe(true)
    expect(routed[0]?.text).toContain('Please review the changes line-by-line')
  })
})

describe('createGithubWebhookHandler — pull_request.opened lands as context', () => {
  it('routes an opened PR as awareness-only context in App mode', async () => {
    const routed: InboundMessage[] = []
    const handler = createGithubWebhookHandler({
      webhookSecret: 'secret',
      dedup: createDeliveryDedup(),
      allowlist: () => ['pull_request.opened'],
      selfId: () => '99',
      selfLogin: () => 'typeclaw-bot',
      authType: () => 'app',
      logger,
      route: async (msg) => {
        routed.push(msg)
        return { kind: 'observed' as const }
      },
    })

    await handler(signedRequest(JSON.stringify(openedPayload()), 'pull_request', 'opened-app'))
    expect(routed).toHaveLength(1)
    expect(routed[0]?.text).not.toContain('requested your review')
    expect(routed[0]?.isBotMention).toBe(false)
  })

  it('routes an opened PR as awareness-only context in PAT mode', async () => {
    const routed: InboundMessage[] = []
    const handler = createGithubWebhookHandler({
      webhookSecret: 'secret',
      dedup: createDeliveryDedup(),
      allowlist: () => ['pull_request.opened'],
      selfId: () => '99',
      selfLogin: () => 'typeclaw-bot',
      authType: () => 'pat',
      logger,
      route: async (msg) => {
        routed.push(msg)
        return { kind: 'observed' as const }
      },
    })

    await handler(signedRequest(JSON.stringify(openedPayload()), 'pull_request', 'opened-pat'))
    expect(routed).toHaveLength(1)
    expect(routed[0]?.text).not.toContain('requested your review')
    expect(routed[0]?.isBotMention).toBe(false)
  })
})

describe('createGithubWebhookHandler — review_requested team gating', () => {
  it('consults isBotInTeam and routes when membership is active', async () => {
    const routed: InboundMessage[] = []
    const calls: Array<{ org: string; slug: string; login: string }> = []
    const handler = createGithubWebhookHandler({
      webhookSecret: 'secret',
      dedup: createDeliveryDedup(),
      allowlist: () => ['pull_request.review_requested'],
      selfId: () => '99',
      selfLogin: () => 'typeclaw-bot',
      isBotInTeam: async (input) => {
        calls.push(input)
        return true
      },
      logger,
      route: async (msg) => {
        routed.push(msg)
        return { kind: 'observed' as const }
      },
    })

    const body = JSON.stringify(reviewRequestedTeamPayload())
    const response = await handler(signedRequest(body, 'pull_request', 'team-1'))

    expect(response.status).toBe(200)
    expect(calls).toEqual([{ org: 'acme', slug: 'reviewers', login: 'typeclaw-bot' }])
    expect(routed[0]?.chat).toBe('pr:7')
  })

  it('drops the event when isBotInTeam resolves false', async () => {
    const routed: InboundMessage[] = []
    const handler = createGithubWebhookHandler({
      webhookSecret: 'secret',
      dedup: createDeliveryDedup(),
      allowlist: () => ['pull_request.review_requested'],
      selfId: () => '99',
      selfLogin: () => 'typeclaw-bot',
      isBotInTeam: async () => false,
      logger,
      route: async (msg) => {
        routed.push(msg)
        return { kind: 'observed' as const }
      },
    })

    await handler(signedRequest(JSON.stringify(reviewRequestedTeamPayload()), 'pull_request', 'team-2'))
    expect(routed).toHaveLength(0)
  })

  it('drops the event when isBotInTeam throws', async () => {
    const routed: InboundMessage[] = []
    const handler = createGithubWebhookHandler({
      webhookSecret: 'secret',
      dedup: createDeliveryDedup(),
      allowlist: () => ['pull_request.review_requested'],
      selfId: () => '99',
      selfLogin: () => 'typeclaw-bot',
      isBotInTeam: async () => {
        throw new Error('boom')
      },
      logger,
      route: async (msg) => {
        routed.push(msg)
        return { kind: 'observed' as const }
      },
    })

    await handler(signedRequest(JSON.stringify(reviewRequestedTeamPayload()), 'pull_request', 'team-3'))
    expect(routed).toHaveLength(0)
  })
})

describe('createGithubWebhookHandler', () => {
  it('acks before the fire-and-forget route promise settles', async () => {
    const routed: InboundMessage[] = []
    const routeWait = Promise.withResolvers<void>()
    const handler = createGithubWebhookHandler({
      webhookSecret: 'secret',
      dedup: createDeliveryDedup(),
      allowlist: () => ['issue_comment.created'],
      selfId: () => '99',
      selfLogin: () => 'typeclaw-bot',
      logger,
      route: async (msg) => {
        routed.push(msg)
        await routeWait.promise
        return { kind: 'observed' as const }
      },
    })

    const body = JSON.stringify(issueCommentPayload({ pullRequest: false }))
    const response = await handler(signedRequest(body, 'issue_comment', 'delivery-1'))

    expect(response.status).toBe(200)
    expect(routed[0]?.chat).toBe('issue:7')
    routeWait.resolve()
  })

  it('drops duplicate deliveries without routing twice', async () => {
    let count = 0
    const handler = createGithubWebhookHandler({
      webhookSecret: 'secret',
      dedup: createDeliveryDedup(),
      allowlist: () => ['issue_comment.created'],
      selfId: () => '99',
      selfLogin: () => 'typeclaw-bot',
      logger,
      route: async () => {
        count++
        return { kind: 'observed' as const }
      },
    })
    const body = JSON.stringify(issueCommentPayload({ pullRequest: false }))

    await handler(signedRequest(body, 'issue_comment', 'same-delivery'))
    await handler(signedRequest(body, 'issue_comment', 'same-delivery'))

    expect(count).toBe(1)
  })

  it('reserves the delivery id before awaiting, so a live + recovery race routes once', async () => {
    let count = 0
    const options: GithubWebhookHandlerOptions = {
      webhookSecret: 'secret',
      dedup: createDeliveryDedup(),
      allowlist: () => ['issue_comment.created'],
      selfId: () => '99',
      selfLogin: () => 'typeclaw-bot',
      logger,
      route: async () => {
        count++
        return { kind: 'observed' as const }
      },
    }
    const payload = issueCommentPayload({ pullRequest: false }) as Record<string, unknown>

    // A live webhook and the recovery sweep process the same guid concurrently.
    await Promise.all([
      processVerifiedGithubDelivery(options, { event: 'issue_comment', delivery: 'race-guid', payload }),
      processVerifiedGithubDelivery(options, { event: 'issue_comment', delivery: 'race-guid', payload }),
    ])

    expect(count).toBe(1)
  })
})

describe('createGithubWebhookHandler — pull_request.converted_to_draft control', () => {
  type AbortCall = { workspace: string; prNumber: number; reason: string }
  type CooldownClear = { workspace: string; prId: number }

  function draftHandler(input: {
    allowlist?: () => readonly string[]
    selfId?: string | null
    selfLogin?: string | null
    abortCalls: AbortCall[]
    cooldownClears?: CooldownClear[]
    routed: InboundMessage[]
    tasks: Array<() => Promise<void>>
    info?: string[]
    abortResult?:
      | { kind: 'aborted'; matchedSessions: number; matchedReviewers: number; abortFailures: number }
      | { kind: 'no-live-session' }
  }): (req: Request) => Promise<Response> {
    return createGithubWebhookHandler({
      webhookSecret: 'secret',
      dedup: createDeliveryDedup(),
      allowlist: input.allowlist ?? (() => ['pull_request.converted_to_draft']),
      selfId: () => input.selfId ?? '99',
      selfLogin: () => input.selfLogin ?? 'typeclaw-bot',
      abortGithubPrTurn: async (workspace, prNumber, reason) => {
        input.abortCalls.push({ workspace, prNumber, reason })
        return input.abortResult ?? { kind: 'aborted', matchedSessions: 2, matchedReviewers: 1, abortFailures: 0 }
      },
      clearReconcileCooldown: async (workspace, prId) => {
        input.cooldownClears?.push({ workspace, prId })
        return 'cleared'
      },
      scheduleBackgroundTask: (task) => {
        input.tasks.push(task)
      },
      logger: { info: (message) => input.info?.push(message), warn: () => {}, error: () => {} },
      route: async (message) => {
        input.routed.push(message)
        return { kind: 'observed' as const }
      },
    })
  }

  it('is allowlist-gated, deduplicated, and never routes a conversational inbound', async () => {
    const abortCalls: AbortCall[] = []
    const routed: InboundMessage[] = []
    const tasks: Array<() => Promise<void>> = []
    let allowed = false
    const handler = draftHandler({
      abortCalls,
      routed,
      tasks,
      allowlist: () => (allowed ? ['pull_request.converted_to_draft'] : []),
    })
    const body = JSON.stringify(convertedToDraftPayload())

    await handler(signedRequest(body, 'pull_request', 'draft-excluded'))
    allowed = true
    await handler(signedRequest(body, 'pull_request', 'draft-admitted'))
    await handler(signedRequest(body, 'pull_request', 'draft-admitted'))

    expect(tasks).toHaveLength(1)
    await tasks[0]?.()
    expect(abortCalls).toHaveLength(1)
    expect(routed).toHaveLength(0)
  })

  it('aborts the exact repo and PR, clears its cooldown marker, and logs outcome counts', async () => {
    const abortCalls: AbortCall[] = []
    const cooldownClears: CooldownClear[] = []
    const routed: InboundMessage[] = []
    const tasks: Array<() => Promise<void>> = []
    const info: string[] = []
    const handler = draftHandler({ abortCalls, cooldownClears, routed, tasks, info })

    await handler(
      signedRequest(
        JSON.stringify(convertedToDraftPayload({ owner: 'Acme', name: 'Widgets', prNumber: 1, prId: 101 })),
        'pull_request',
        'draft-target',
      ),
    )
    await tasks[0]?.()

    expect(abortCalls).toEqual([{ workspace: 'Acme/Widgets', prNumber: 1, reason: 'pull request converted to draft' }])
    expect(cooldownClears).toEqual([{ workspace: 'Acme/Widgets', prId: 101 }])
    expect(
      info.some(
        (message) => message.includes('Acme/Widgets#1') && message.includes('sessions=2 reviewers=1 failures=0'),
      ),
    ).toBe(true)
    expect(routed).toHaveLength(0)
  })

  it('still aborts when the draft transition is self-authored', async () => {
    const abortCalls: AbortCall[] = []
    const routed: InboundMessage[] = []
    const tasks: Array<() => Promise<void>> = []
    const handler = draftHandler({ abortCalls, routed, tasks })
    const payload = convertedToDraftPayload()
    payload.sender = { login: 'typeclaw-bot', id: 99, type: 'Bot' }

    await handler(signedRequest(JSON.stringify(payload), 'pull_request', 'draft-self-authored'))
    await tasks[0]?.()

    expect(abortCalls).toHaveLength(1)
    expect(routed).toHaveLength(0)
  })

  it('targets neither another PR nor another repository', async () => {
    const active = new Set(['acme/project#1', 'acme/project#2', 'acme/other#1'])
    const tasks: Array<() => Promise<void>> = []
    const handler = createGithubWebhookHandler({
      webhookSecret: 'secret',
      dedup: createDeliveryDedup(),
      allowlist: () => ['pull_request.converted_to_draft'],
      selfId: () => '99',
      selfLogin: () => 'typeclaw-bot',
      abortGithubPrTurn: async (workspace, prNumber) => {
        active.delete(`${workspace}#${prNumber}`)
        return { kind: 'aborted', matchedSessions: 1, matchedReviewers: 0, abortFailures: 0 }
      },
      scheduleBackgroundTask: (task) => tasks.push(task),
      logger,
      route: async () => ({ kind: 'observed' }),
    })

    await handler(
      signedRequest(
        JSON.stringify(convertedToDraftPayload({ owner: 'acme', name: 'project', prNumber: 1 })),
        'pull_request',
        'draft-scope',
      ),
    )
    await tasks[0]?.()

    expect([...active]).toEqual(['acme/project#2', 'acme/other#1'])
  })

  it('logs no-live-session distinctly when there was no running review', async () => {
    const info: string[] = []
    const tasks: Array<() => Promise<void>> = []
    const handler = draftHandler({
      abortCalls: [],
      routed: [],
      tasks,
      info,
      abortResult: { kind: 'no-live-session' },
    })

    await handler(signedRequest(JSON.stringify(convertedToDraftPayload()), 'pull_request', 'draft-idle'))
    await tasks[0]?.()

    expect(info.some((message) => message.includes('acme/project#7') && message.includes('no-live-session'))).toBe(true)
  })

  it('logs and skips when abort wiring and the cooldown store are unavailable', async () => {
    const info: string[] = []
    const tasks: Array<() => Promise<void>> = []
    const handler = createGithubWebhookHandler({
      webhookSecret: 'secret',
      dedup: createDeliveryDedup(),
      allowlist: () => ['pull_request.converted_to_draft'],
      selfId: () => '99',
      selfLogin: () => 'typeclaw-bot',
      scheduleBackgroundTask: (task) => tasks.push(task),
      logger: { info: (message) => info.push(message), warn: () => {}, error: () => {} },
      route: async () => ({ kind: 'observed' }),
    })

    await handler(signedRequest(JSON.stringify(convertedToDraftPayload()), 'pull_request', 'draft-unwired'))
    await tasks[0]?.()

    expect(info.some((message) => message.includes('abort unavailable'))).toBe(true)
    expect(
      info.some((message) => message.includes('cooldown clear skipped') && message.includes('not initialized')),
    ).toBe(true)
  })
})

describe('createGithubWebhookHandler — review comment parent lookup', () => {
  function handlerWithParentLookup(
    routed: InboundMessage[],
    parentUser: Record<string, unknown>,
  ): (req: Request) => Promise<Response> {
    return createGithubWebhookHandler({
      webhookSecret: 'secret',
      dedup: createDeliveryDedup(),
      allowlist: () => ['pull_request_review_comment.created'],
      selfId: () => '99',
      selfLogin: () => 'typeclaw-bot[bot]',
      authToken: async () => 'tok',
      fetchImpl: fakeFetch((url, init) => {
        expect(url).toBe('https://api.github.com/repos/acme/project/pulls/comments/101')
        expect(init?.method ?? 'GET').toBe('GET')
        return new Response(JSON.stringify({ id: 101, user: parentUser }), { status: 200 })
      }),
      logger,
      route: async (msg) => {
        routed.push(msg)
        return { kind: 'observed' as const }
      },
    })
  }

  it('routes review-comment replies to self with replyToBotMessageId', async () => {
    const routed: InboundMessage[] = []
    const handler = handlerWithParentLookup(routed, { login: 'typeclaw-bot[bot]', id: 99, type: 'Bot' })

    await handler(signedRequest(JSON.stringify(reviewCommentPayload()), 'pull_request_review_comment', 'parent-self'))

    expect(routed).toHaveLength(1)
    expect(routed[0]?.replyToBotMessageId).toBe('101')
    expect(routed[0]?.replyToOtherMessageId).toBe(null)
    expect(routed[0]?.suppressSticky).toBe(true)
    expect(routed[0]?.githubReviewThreadCloseout).toMatchObject({
      workspace: 'acme/project',
      prNumber: 7,
      rootCommentId: '101',
    })
  })

  it('routes review-comment replies to other authors with replyToOtherMessageId', async () => {
    const routed: InboundMessage[] = []
    const handler = handlerWithParentLookup(routed, { login: 'alice', id: 10, type: 'User' })

    await handler(signedRequest(JSON.stringify(reviewCommentPayload()), 'pull_request_review_comment', 'parent-other'))

    expect(routed).toHaveLength(1)
    expect(routed[0]?.replyToBotMessageId).toBe(null)
    expect(routed[0]?.replyToOtherMessageId).toBe('101')
    expect(routed[0]?.suppressSticky).toBe(true)
    expect(routed[0]?.githubReviewThreadCloseout).toBeUndefined()
  })
})

describe('createGithubWebhookHandler — reply review rounds', () => {
  function replyRoundHandler(input: {
    routed: InboundMessage[]
    fetchImpl: typeof fetch
    generateReviewRoundId?: () => string
    now?: () => number
  }): (req: Request) => Promise<Response> {
    return createGithubWebhookHandler({
      webhookSecret: 'secret',
      dedup: createDeliveryDedup(),
      allowlist: () => ['pull_request_review_comment.created'],
      selfId: () => '99',
      selfLogin: () => 'typeclaw-bot[bot]',
      authToken: async () => 'tok',
      fetchImpl: input.fetchImpl,
      generateReviewRoundId: input.generateReviewRoundId,
      now: input.now,
      logger,
      route: async (message) => {
        input.routed.push(message)
        return { kind: 'observed' as const }
      },
    })
  }

  function replyRoundFetch(input: {
    parentAuthors?: Record<number, Record<string, unknown>>
    reviewState?: 'blocking' | 'blocking-without-id' | 'clear' | 'failed'
    calls?: string[]
  }): typeof fetch {
    return fakeFetch((url) => {
      input.calls?.push(url)
      const parentMatch = /\/pulls\/comments\/(\d+)$/.exec(url)
      if (parentMatch !== null) {
        const parentId = Number(parentMatch[1])
        const author = input.parentAuthors?.[parentId] ?? { login: 'typeclaw-bot[bot]', id: 99, type: 'Bot' }
        return new Response(JSON.stringify({ id: parentId, user: author }), { status: 200 })
      }
      if (url.includes('/pulls/') && url.includes('/reviews')) {
        if (input.reviewState === 'failed') return new Response('boom', { status: 500 })
        const reviews =
          input.reviewState === 'clear'
            ? [{ id: 7001, state: 'APPROVED', user: { login: 'typeclaw-bot[bot]', type: 'Bot' } }]
            : [
                {
                  ...(input.reviewState === 'blocking-without-id' ? {} : { id: 7001 }),
                  state: 'CHANGES_REQUESTED',
                  user: { login: 'typeclaw-bot[bot]', type: 'Bot' },
                },
              ]
        return new Response(JSON.stringify(reviews), { status: 200 })
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
  }

  async function expectQualifyingControlToArm(delivery: string): Promise<void> {
    const routed: InboundMessage[] = []
    const handler = replyRoundHandler({
      routed,
      fetchImpl: replyRoundFetch({}),
      generateReviewRoundId: () => `${delivery}-round`,
    })
    await handler(
      signedRequest(
        JSON.stringify(reviewCommentPayload({ inReplyToId: 909, headSha: 'sha-control' })),
        'pull_request_review_comment',
        delivery,
      ),
    )
    expect(routed[0]?.githubReviewRound?.roundId).toBe(`${delivery}-round`)
  }

  it('coalesces replies to different self-authored threads and keeps the first thread as carrier', async () => {
    __resetReviewVerdictGuardForTest()
    const routed: InboundMessage[] = []
    let nonce = 0
    const handler = replyRoundHandler({
      routed,
      fetchImpl: replyRoundFetch({}),
      generateReviewRoundId: () => `reply-${++nonce}`,
    })

    await handler(
      signedRequest(
        JSON.stringify(reviewCommentPayload({ inReplyToId: 101, id: 201, headSha: 'sha-one' })),
        'pull_request_review_comment',
        'reply-round-first',
      ),
    )
    await handler(
      signedRequest(
        JSON.stringify(reviewCommentPayload({ inReplyToId: 102, id: 202, headSha: 'sha-one' })),
        'pull_request_review_comment',
        'reply-round-second',
      ),
    )

    expect(routed).toHaveLength(2)
    expect(routed[0]?.githubReviewRound).toEqual({
      kind: 'reply',
      roundId: 'reply-1',
      workspace: 'acme/project',
      prNumber: 7,
      headSha: 'sha-one',
      carrierThread: '101',
    })
    expect(routed[1]?.githubReviewRound).toEqual(routed[0]?.githubReviewRound)
    expect(routed[0]?.thread).toBe('101')
    expect(routed[1]?.thread).toBe('102')
    expect(nonce).toBe(1)
  })

  it('makes a lone qualifying reply the carrier of a singleton round', async () => {
    __resetReviewVerdictGuardForTest()
    const routed: InboundMessage[] = []
    const handler = replyRoundHandler({
      routed,
      fetchImpl: replyRoundFetch({}),
      generateReviewRoundId: () => 'singleton-reply',
    })

    await handler(
      signedRequest(
        JSON.stringify(reviewCommentPayload({ inReplyToId: 101, headSha: 'sha-one' })),
        'pull_request_review_comment',
        'reply-round-singleton',
      ),
    )

    expect(routed[0]?.githubReviewRound?.roundId).toBe('singleton-reply')
    expect(routed[0]?.githubReviewRound?.carrierThread).toBe('101')
  })

  it('does not arm a round or read review state for a reply rooted by a human', async () => {
    __resetReviewVerdictGuardForTest()
    const routed: InboundMessage[] = []
    const calls: string[] = []
    const handler = replyRoundHandler({
      routed,
      fetchImpl: replyRoundFetch({
        parentAuthors: { 101: { login: 'alice', id: 10, type: 'User' } },
        calls,
      }),
    })

    await handler(
      signedRequest(
        JSON.stringify(reviewCommentPayload({ inReplyToId: 101, headSha: 'sha-one' })),
        'pull_request_review_comment',
        'reply-round-human-root',
      ),
    )

    expect(routed).toHaveLength(1)
    expect(routed[0]?.githubReviewRound).toBeUndefined()
    expect(calls.filter((url) => url.includes('/reviews'))).toHaveLength(0)
    await expectQualifyingControlToArm('reply-round-human-root-control')
  })

  it('does not arm a round or make network calls for a top-level inline comment', async () => {
    __resetReviewVerdictGuardForTest()
    const routed: InboundMessage[] = []
    const calls: string[] = []
    const handler = replyRoundHandler({ routed, fetchImpl: replyRoundFetch({ calls }) })

    await handler(
      signedRequest(
        JSON.stringify(reviewCommentPayload({ inReplyToId: null, headSha: 'sha-one' })),
        'pull_request_review_comment',
        'reply-round-top-level',
      ),
    )

    expect(routed).toHaveLength(1)
    expect(routed[0]?.githubReviewRound).toBeUndefined()
    expect(calls).toHaveLength(0)
    await expectQualifyingControlToArm('reply-round-top-level-control')
  })

  it('does not arm a round when the bot has no effective blocking review', async () => {
    __resetReviewVerdictGuardForTest()
    const routed: InboundMessage[] = []
    const handler = replyRoundHandler({ routed, fetchImpl: replyRoundFetch({ reviewState: 'clear' }) })

    await handler(
      signedRequest(
        JSON.stringify(reviewCommentPayload({ inReplyToId: 101, headSha: 'sha-one' })),
        'pull_request_review_comment',
        'reply-round-clear',
      ),
    )

    expect(routed).toHaveLength(1)
    expect(routed[0]?.githubReviewRound).toBeUndefined()
    await expectQualifyingControlToArm('reply-round-clear-control')
  })

  it('does not arm a round when the blocking review has no stable id', async () => {
    __resetReviewVerdictGuardForTest()
    const routed: InboundMessage[] = []
    const handler = replyRoundHandler({
      routed,
      fetchImpl: replyRoundFetch({ reviewState: 'blocking-without-id' }),
    })

    await handler(
      signedRequest(
        JSON.stringify(reviewCommentPayload({ inReplyToId: 101, headSha: 'sha-one' })),
        'pull_request_review_comment',
        'reply-round-missing-review-id',
      ),
    )

    expect(routed).toHaveLength(1)
    expect(routed[0]?.githubReviewRound).toBeUndefined()
    await expectQualifyingControlToArm('reply-round-missing-review-id-control')
  })

  it('routes a lookup failure with a bounded unknown-state close-out deferral', async () => {
    __resetReviewVerdictGuardForTest()
    const routed: InboundMessage[] = []
    const handler = replyRoundHandler({
      routed,
      fetchImpl: replyRoundFetch({ reviewState: 'failed' }),
      now: () => 10_000,
    })

    const response = await handler(
      signedRequest(
        JSON.stringify(reviewCommentPayload({ inReplyToId: 101, headSha: 'sha-one' })),
        'pull_request_review_comment',
        'reply-round-failed-state',
      ),
    )

    expect(response.status).toBe(200)
    expect(routed).toHaveLength(1)
    expect(routed[0]?.thread).toBe('101')
    expect(routed[0]?.githubReviewRound).toBeUndefined()
    expect(routed[0]?.githubReviewThreadCloseout?.deferUntil).toEqual({
      kind: 'review-state-unknown',
      expiresAt: 130_000,
    })
    await expectQualifyingControlToArm('reply-round-failed-state-control')
  })
})

describe('createGithubWebhookHandler — self-author drop', () => {
  function selfAuthoredHandler(
    routed: InboundMessage[],
    overrides: { selfId?: string | null; selfLogin?: string | null; allowlist?: readonly string[] } = {},
  ): (req: Request) => Promise<Response> {
    return createGithubWebhookHandler({
      webhookSecret: 'secret',
      dedup: createDeliveryDedup(),
      allowlist: () =>
        overrides.allowlist ?? ['issue_comment.created', 'pull_request_review_comment.created', 'issues.opened'],
      selfId: () => overrides.selfId ?? '99',
      selfLogin: () => overrides.selfLogin ?? 'typeclaw-bot',
      logger,
      route: async (msg) => {
        routed.push(msg)
        return { kind: 'observed' as const }
      },
    })
  }

  it('drops issue_comment authored by self (matched by id)', async () => {
    const routed: InboundMessage[] = []
    const handler = selfAuthoredHandler(routed)
    const payload = issueCommentPayload({ pullRequest: false })
    ;(payload.comment as Record<string, unknown>).user = { login: 'typeclaw-bot', id: 99, type: 'Bot' }
    await handler(signedRequest(JSON.stringify(payload), 'issue_comment', 'self-by-id'))
    expect(routed).toHaveLength(0)
  })

  it('drops issue_comment authored by self (matched by login when id differs)', async () => {
    const routed: InboundMessage[] = []
    const handler = selfAuthoredHandler(routed)
    const payload = issueCommentPayload({ pullRequest: false })
    // Same login, different id — simulates the issue #452 case where the
    // id-only guard would have let the webhook through.
    ;(payload.comment as Record<string, unknown>).user = { login: 'typeclaw-bot', id: 12345, type: 'Bot' }
    await handler(signedRequest(JSON.stringify(payload), 'issue_comment', 'self-by-login'))
    expect(routed).toHaveLength(0)
  })

  it('drops pull_request_review_comment authored by self (matched by login)', async () => {
    const routed: InboundMessage[] = []
    const handler = selfAuthoredHandler(routed)
    const payload = reviewCommentPayload()
    ;(payload.comment as Record<string, unknown>).user = { login: 'typeclaw-bot', id: 54321, type: 'Bot' }
    await handler(signedRequest(JSON.stringify(payload), 'pull_request_review_comment', 'self-review-by-login'))
    expect(routed).toHaveLength(0)
  })

  it('drops issues.opened authored by self (matched by login)', async () => {
    const routed: InboundMessage[] = []
    const handler = selfAuthoredHandler(routed)
    const payload = {
      action: 'opened',
      repository: repo(),
      issue: {
        number: 11,
        id: 1100,
        body: 'opened by the bot',
        created_at: '2026-01-01T00:00:00Z',
        user: { login: 'typeclaw-bot', id: 12345, type: 'Bot' },
      },
    }
    await handler(signedRequest(JSON.stringify(payload), 'issues', 'self-issue-by-login'))
    expect(routed).toHaveLength(0)
  })

  it('routes issue_comment from a different author when neither id nor login matches', async () => {
    const routed: InboundMessage[] = []
    const handler = selfAuthoredHandler(routed)
    const body = JSON.stringify(issueCommentPayload({ pullRequest: false }))
    await handler(signedRequest(body, 'issue_comment', 'other-author'))
    expect(routed).toHaveLength(1)
    expect(routed[0]?.authorName).toBe('alice')
  })

  it('still drops by login when selfId is null (e.g. id getter not yet resolved)', async () => {
    const routed: InboundMessage[] = []
    const handler = selfAuthoredHandler(routed, { selfId: null })
    const payload = issueCommentPayload({ pullRequest: false })
    ;(payload.comment as Record<string, unknown>).user = { login: 'typeclaw-bot', id: 99, type: 'Bot' }
    await handler(signedRequest(JSON.stringify(payload), 'issue_comment', 'self-id-null'))
    expect(routed).toHaveLength(0)
  })

  it('drops pull_request_review authored by self even when the PR was opened by someone else', async () => {
    // Regression for PR #460: the bot submits a review on alice's PR. The
    // payload's `pull_request.user` is alice, but `review.user` is the bot.
    // The drop must read the review author, not the PR author, or the bot
    // wakes a session on its own review and loops.
    const routed: InboundMessage[] = []
    const handler = selfAuthoredHandler(routed, {
      allowlist: ['pull_request_review.submitted'],
    })
    const payload = {
      action: 'submitted',
      repository: repo(),
      pull_request: { number: 7, id: 700, user: { login: 'alice', id: 10, type: 'User' } },
      review: {
        id: 5001,
        body: 'looks good',
        submitted_at: '2026-01-01T00:00:00Z',
        user: { login: 'typeclaw-bot', id: 99, type: 'Bot' },
      },
    }
    await handler(signedRequest(JSON.stringify(payload), 'pull_request_review', 'self-review-submitted'))
    expect(routed).toHaveLength(0)
  })

  it('routes a pull_request_review from another reviewer on the bot-authored PR', async () => {
    // Guard against over-dropping: the inverse case must still wake the bot.
    // alice reviews the bot's PR — `pull_request.user` is the bot, but the
    // review author is alice, so the event must route.
    const routed: InboundMessage[] = []
    const handler = selfAuthoredHandler(routed, {
      allowlist: ['pull_request_review.submitted'],
    })
    const payload = {
      action: 'submitted',
      repository: repo(),
      pull_request: { number: 7, id: 700, user: { login: 'typeclaw-bot', id: 99, type: 'Bot' } },
      review: { id: 5002, body: 'please fix', submitted_at: '2026-01-01T00:00:00Z', user: user() },
    }
    await handler(signedRequest(JSON.stringify(payload), 'pull_request_review', 'other-review-submitted'))
    expect(routed).toHaveLength(1)
    expect(routed[0]?.authorName).toBe('alice')
  })

  it('drops self-authored events with no enumerated entity via the sender fallback', async () => {
    const drops: string[] = []
    const handler = createGithubWebhookHandler({
      webhookSecret: 'secret',
      dedup: createDeliveryDedup(),
      allowlist: () => ['commit_comment'],
      selfId: () => '99',
      selfLogin: () => 'typeclaw-bot',
      logger: { ...logger, info: (m) => drops.push(m) },
      route: async (msg) => {
        routedSink.push(msg)
        return { kind: 'observed' as const }
      },
    })
    const routedSink: InboundMessage[] = []
    const payload = {
      action: 'created',
      repository: repo(),
      sender: { login: 'typeclaw-bot', id: 99, type: 'Bot' },
    }
    await handler(signedRequest(JSON.stringify(payload), 'commit_comment', 'self-sender-fallback'))
    expect(routedSink).toHaveLength(0)
    expect(drops.some((m) => m.includes('dropped self-authored'))).toBe(true)
  })

  it('drops self-authored events for an unknown event type via the sender fallback', async () => {
    const drops: string[] = []
    const routedSink: InboundMessage[] = []
    const handler = createGithubWebhookHandler({
      webhookSecret: 'secret',
      dedup: createDeliveryDedup(),
      allowlist: () => ['some_future_event'],
      selfId: () => '99',
      selfLogin: () => 'typeclaw-bot',
      logger: { ...logger, info: (m) => drops.push(m) },
      route: async (msg) => {
        routedSink.push(msg)
        return { kind: 'observed' as const }
      },
    })
    const payload = {
      action: 'created',
      repository: repo(),
      sender: { login: 'typeclaw-bot', id: 99, type: 'Bot' },
    }
    await handler(signedRequest(JSON.stringify(payload), 'some_future_event', 'self-unknown-event'))
    expect(routedSink).toHaveLength(0)
    expect(drops.some((m) => m.includes('dropped self-authored'))).toBe(true)
  })

  it('routes a pull_request action from a human on a bot-opened PR', async () => {
    // Regression for the over-drop on `pull_request` events: PR #462 resolved
    // the author from `pull_request.user` (the OPENER), so a human action on a
    // bot-opened PR matched the bot by login and was wrongly dropped — the
    // comment landed as awareness-only "Recent context" and the agent never
    // replied. The self-author identity for a `pull_request` action is the
    // ACTOR (`sender`), not the opener.
    const routed: InboundMessage[] = []
    const handler = selfAuthoredHandler(routed, {
      allowlist: ['pull_request.review_requested'],
    })
    const payload = {
      action: 'review_requested',
      repository: repo(),
      sender: { login: 'alice', id: 10, type: 'User' },
      requested_reviewer: { login: 'typeclaw-bot', id: 99, type: 'User' },
      pull_request: {
        number: 7,
        id: 700,
        title: 'Add feature',
        user: { login: 'typeclaw-bot', id: 99, type: 'Bot' },
        head: { ref: 'feat-branch' },
        base: { ref: 'main' },
      },
    }
    await handler(signedRequest(JSON.stringify(payload), 'pull_request', 'human-action-bot-pr'))
    expect(routed).toHaveLength(1)
    expect(routed[0]?.authorName).toBe('alice')
  })

  it('drops a pull_request action the bot itself triggered on its own PR', async () => {
    // Self-loop guard must still fire: the bot requesting a review on its own
    // PR is `sender = bot`, and that delivery must not wake a session.
    const routed: InboundMessage[] = []
    const handler = selfAuthoredHandler(routed, {
      allowlist: ['pull_request.review_requested'],
    })
    const payload = {
      action: 'review_requested',
      repository: repo(),
      sender: { login: 'typeclaw-bot', id: 99, type: 'Bot' },
      requested_reviewer: { login: 'someone-else', id: 20, type: 'User' },
      pull_request: {
        number: 7,
        id: 700,
        title: 'Add feature',
        user: { login: 'typeclaw-bot', id: 99, type: 'Bot' },
        head: { ref: 'feat-branch' },
        base: { ref: 'main' },
      },
    }
    await handler(signedRequest(JSON.stringify(payload), 'pull_request', 'bot-action-own-pr'))
    expect(routed).toHaveLength(0)
  })

  it('drops a pull_request_review_thread the bot itself resolved', async () => {
    // pull_request_review_thread carries only the `pull_request` container
    // (opener), so the self-author identity must come from `sender`. A bot
    // resolving its own review thread must not wake a session.
    const routed: InboundMessage[] = []
    const handler = selfAuthoredHandler(routed, {
      allowlist: ['pull_request_review_thread.resolved'],
    })
    const payload = {
      action: 'resolved',
      repository: repo(),
      sender: { login: 'typeclaw-bot', id: 99, type: 'Bot' },
      pull_request: { number: 7, id: 700, user: { login: 'alice', id: 10, type: 'User' } },
      thread: { id: 333 },
    }
    await handler(signedRequest(JSON.stringify(payload), 'pull_request_review_thread', 'bot-thread-resolved'))
    expect(routed).toHaveLength(0)
  })
})

describe('decoy reviewer drop on self-review', () => {
  type DropCall = { url: string; method: string; body: string }

  function decoyDropHandler(overrides: {
    authType?: 'pat' | 'app'
    authToken?: GithubWebhookHandlerOptions['authToken']
    fetchImpl?: typeof fetch
    warns?: string[]
  }): {
    handler: (req: Request) => Promise<Response>
    tasks: Array<() => Promise<void>>
    drops: DropCall[]
  } {
    const tasks: Array<() => Promise<void>> = []
    const drops: DropCall[] = []
    const fetchImpl =
      overrides.fetchImpl ??
      fakeFetch((url, init) => {
        drops.push({ url, method: init?.method ?? 'GET', body: String(init?.body ?? '') })
        return new Response('', { status: 200 })
      })
    const handler = createGithubWebhookHandler({
      webhookSecret: 'secret',
      dedup: createDeliveryDedup(),
      allowlist: () => ['pull_request_review.submitted'],
      selfId: () => '99',
      selfLogin: () => 'typeclaw-bot[bot]',
      authType: () => overrides.authType ?? 'app',
      authToken: overrides.authToken ?? (async () => 'tok'),
      fetchImpl,
      scheduleBackgroundTask: (task) => {
        tasks.push(task)
      },
      logger: {
        info: () => {},
        warn: (m) => overrides.warns?.push(m),
        error: () => {},
      },
      route: async () => ({ kind: 'observed' }),
    })
    return { handler, tasks, drops }
  }

  function selfReviewPayload(): Record<string, unknown> {
    return {
      action: 'submitted',
      repository: repo(),
      pull_request: { number: 7, id: 700, user: { login: 'alice', id: 10, type: 'User' } },
      review: {
        id: 5001,
        body: 'looks good',
        submitted_at: '2026-01-01T00:00:00Z',
        user: { login: 'typeclaw-bot[bot]', id: 99, type: 'Bot' },
      },
    }
  }

  it('fires a DELETE for the decoy login when the bot submits its own review (App auth)', async () => {
    const { handler, tasks, drops } = decoyDropHandler({})
    const res = await handler(
      signedRequest(JSON.stringify(selfReviewPayload()), 'pull_request_review', 'self-review-app'),
    )
    // given the 200-fast contract, the ACK returns before the scheduled drop runs
    expect(res.status).toBe(200)
    expect(tasks).toHaveLength(1)
    await tasks[0]?.()
    expect(drops).toHaveLength(1)
    expect(drops[0]?.method).toBe('DELETE')
    expect(drops[0]?.url).toBe('https://api.github.com/repos/acme/project/pulls/7/requested_reviewers')
    expect(JSON.parse(drops[0]?.body ?? '{}')).toEqual({ reviewers: ['typeclaw-bot'] })
  })

  it('does not fire under PAT auth (no decoy account exists)', async () => {
    const { handler, tasks } = decoyDropHandler({ authType: 'pat' })
    await handler(signedRequest(JSON.stringify(selfReviewPayload()), 'pull_request_review', 'self-review-pat'))
    expect(tasks).toHaveLength(0)
  })

  it('does not fire for a non-review self-authored event', async () => {
    const tasks: Array<() => Promise<void>> = []
    const handler = createGithubWebhookHandler({
      webhookSecret: 'secret',
      dedup: createDeliveryDedup(),
      allowlist: () => ['issue_comment.created'],
      selfId: () => '99',
      selfLogin: () => 'typeclaw-bot[bot]',
      authType: () => 'app',
      authToken: async () => 'tok',
      fetchImpl: fakeFetch(() => new Response('', { status: 200 })),
      scheduleBackgroundTask: (task) => {
        tasks.push(task)
      },
      logger,
      route: async () => ({ kind: 'observed' }),
    })
    const payload = {
      action: 'created',
      repository: repo(),
      issue: { number: 7, pull_request: {} },
      comment: {
        id: 99,
        body: 'done',
        created_at: '2026-01-01T00:00:00Z',
        user: { login: 'typeclaw-bot[bot]', id: 99, type: 'Bot' },
      },
    }
    await handler(signedRequest(JSON.stringify(payload), 'issue_comment', 'self-comment-no-drop'))
    expect(tasks).toHaveLength(0)
  })

  it('treats a 422 (reviewer not requested) as a benign no-op without warning', async () => {
    const warns: string[] = []
    const { handler, tasks } = decoyDropHandler({
      warns,
      fetchImpl: fakeFetch(() => new Response('Reviewers do not have permission', { status: 422 })),
    })
    await handler(signedRequest(JSON.stringify(selfReviewPayload()), 'pull_request_review', 'self-review-422'))
    await tasks[0]?.()
    expect(warns).toHaveLength(0)
  })

  it('warns when the DELETE fails for a real reason (e.g. 403 auth)', async () => {
    const warns: string[] = []
    const { handler, tasks } = decoyDropHandler({
      warns,
      fetchImpl: fakeFetch(() => new Response('Resource not accessible by integration', { status: 403 })),
    })
    await handler(signedRequest(JSON.stringify(selfReviewPayload()), 'pull_request_review', 'self-review-403'))
    await tasks[0]?.()
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain('failed to drop decoy reviewer @typeclaw-bot')
  })

  it('warns when minting the App token throws (failure must not be swallowed)', async () => {
    const warns: string[] = []
    const { handler, tasks } = decoyDropHandler({
      warns,
      authToken: async () => {
        throw new Error('installation lookup failed')
      },
    })
    await handler(signedRequest(JSON.stringify(selfReviewPayload()), 'pull_request_review', 'self-review-token-throw'))
    await tasks[0]?.()
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain('failed to drop decoy reviewer @typeclaw-bot')
    expect(warns[0]).toContain('installation lookup failed')
  })
})

function fakeFetch(fn: (input: string, init?: RequestInit) => Response): typeof fetch {
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
    fn(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url, init)
  return Object.assign(impl, { preconnect: () => {} }) as typeof fetch
}

describe('createGithubWebhookHandler — pull_request.synchronize recheck', () => {
  type ThreadNode = {
    id: string
    isResolved: boolean
    rootCommentId: number
    login: string
    isBot?: boolean
    path?: string | null
    line?: number | null
    body?: string
  }
  type SelfReviewRow = { state: string; login?: string; type?: string }

  function threadsResponse(threads: ThreadNode[]): Response {
    return new Response(
      JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: threads.map((t) => ({
                  id: t.id,
                  isResolved: t.isResolved,
                  path: t.path ?? null,
                  line: t.line ?? null,
                  comments: {
                    nodes: [
                      {
                        databaseId: t.rootCommentId,
                        body: t.body,
                        author: { __typename: t.isBot === false ? 'User' : 'Bot', login: t.login },
                      },
                    ],
                  },
                })),
              },
            },
          },
        },
      }),
      { status: 200 },
    )
  }

  function reviewsResponse(reviews: SelfReviewRow[]): Response {
    return new Response(
      JSON.stringify(
        reviews.map((r) => ({ state: r.state, user: { login: r.login ?? 'typeclaw-bot', type: r.type ?? 'Bot' } })),
      ),
      { status: 200 },
    )
  }

  // The followup mints one GraphQL call (unresolved threads) and one REST call
  // (latest self review state). Route by URL so each query gets its own fixture.
  function followupFetch(input: { threads?: ThreadNode[]; reviews?: SelfReviewRow[] }): typeof fetch {
    return fakeFetch((url) => {
      if (url.includes('/pulls/') && url.includes('/reviews')) return reviewsResponse(input.reviews ?? [])
      return threadsResponse(input.threads ?? [])
    })
  }

  function threadsFetch(threads: ThreadNode[]): typeof fetch {
    return followupFetch({ threads })
  }

  function recheckHandler(input: {
    fetchImpl: typeof fetch
    routed: InboundMessage[]
    tasks: Array<() => Promise<void>>
    warns?: string[]
    authToken?: GithubWebhookHandlerOptions['authToken']
    reviewOn?: 'review_requested' | 'opened' | 'off'
    sleepImpl?: GithubWebhookHandlerOptions['sleepImpl']
    allowApprove?: boolean
    route?: GithubWebhookHandlerOptions['route']
    generateReviewRoundId?: () => string
  }) {
    return createGithubWebhookHandler({
      webhookSecret: 'secret',
      dedup: createDeliveryDedup(),
      allowlist: () => ['pull_request.synchronize'],
      selfId: () => '99',
      selfLogin: () => 'typeclaw-bot[bot]',
      authType: () => 'app',
      ...(input.allowApprove !== undefined ? { allowApprove: () => input.allowApprove! } : {}),
      ...(input.reviewOn !== undefined ? { reviewOn: () => input.reviewOn! } : {}),
      authToken: input.authToken ?? (async () => 'tok'),
      generateReviewRoundId: input.generateReviewRoundId ?? (() => 'round-id'),
      fetchImpl: input.fetchImpl,
      scheduleBackgroundTask: (task) => {
        input.tasks.push(task)
      },
      sleepImpl: input.sleepImpl ?? (async () => {}),
      logger: { info: () => {}, warn: (m) => input.warns?.push(m), error: () => {} },
      route: async (msg) => {
        input.routed.push(msg)
        return { kind: 'observed' as const }
      },
      ...(input.route ? { route: input.route } : {}),
    })
  }

  function synchronizePayload(headSha = 'abc1234def'): Record<string, unknown> {
    return {
      action: 'synchronize',
      repository: repo(),
      pull_request: {
        number: 7,
        id: 700,
        title: 'Add widget',
        head: { ref: 'feature', sha: headSha },
        base: { ref: 'main' },
        user: { login: 'alice', id: 10, type: 'User' },
      },
      sender: { login: 'alice', id: 10, type: 'User' },
    }
  }

  it('deduplicates partial followup retries and reboot redelivery while admitting a new commit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'github-followup-journal-'))
    let journal = new InboundJournal(dir, { epoch: 'one' })
    const receipts: string[] = []
    let failSecond = true
    let round = 0
    const tasks: Array<() => Promise<void>> = []
    const route: GithubWebhookHandlerOptions['route'] = async (message) => {
      if (message.thread === '200' && failSecond) {
        failSecond = false
        throw new Error('admission interrupted')
      }
      const target = {
        adapter: message.adapter,
        workspace: message.workspace,
        chat: message.chat,
        thread: message.thread,
      }
      const receipt = await journal.admit({
        target,
        principal: {
          kind: 'channel',
          adapter: message.adapter,
          workspace: message.workspace,
          chat: message.chat,
          lastInboundAuthorId: message.authorId,
        },
        accountIdentity: 'github:99',
        messageId: message.externalMessageId,
        eventKind: message.eventKind!,
        revision: message.revision!,
      })
      receipts.push(`${message.thread}:${receipt.kind}`)
      return receipt.kind === 'accepted'
        ? receipt
        : { kind: 'duplicate', inputId: receipt.inputId, outcome: receipt.outcome?.kind }
    }
    const makeHandler = () =>
      recheckHandler({
        routed: [],
        tasks,
        route,
        generateReviewRoundId: () => `ephemeral-round-${++round}`,
        fetchImpl: followupFetch({
          threads: [
            { id: 'T1', isResolved: false, rootCommentId: 100, login: 'typeclaw-bot' },
            { id: 'T2', isResolved: false, rootCommentId: 200, login: 'typeclaw-bot' },
          ],
          reviews: [{ state: 'CHANGES_REQUESTED' }],
        }),
      })
    try {
      const payload = JSON.stringify(synchronizePayload('commit-one'))
      await makeHandler()(signedRequest(payload, 'pull_request', 'same-delivery'))
      await tasks.shift()?.()
      expect(receipts).toEqual(['100:accepted', '100:duplicate', '200:accepted'])
      await journal.close()
      journal = new InboundJournal(dir, { epoch: 'two' })
      const rebooted = makeHandler()
      await rebooted(signedRequest(payload, 'pull_request', 'same-delivery'))
      await tasks.shift()?.()
      expect(receipts.slice(-2)).toEqual(['100:duplicate', '200:duplicate'])
      await rebooted(signedRequest(JSON.stringify(synchronizePayload('commit-two')), 'pull_request', 'new-delivery'))
      await tasks.shift()?.()
      expect(receipts.slice(-2)).toEqual(['100:accepted', '200:accepted'])
    } finally {
      await journal.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('does not route when the PR has no bot-authored unresolved threads', async () => {
    const routed: InboundMessage[] = []
    const tasks: Array<() => Promise<void>> = []
    const handler = recheckHandler({
      fetchImpl: threadsFetch([{ id: 'T_HUMAN', isResolved: false, rootCommentId: 5, login: 'alice', isBot: false }]),
      routed,
      tasks,
    })

    const res = await handler(signedRequest(JSON.stringify(synchronizePayload()), 'pull_request', 'sync-none'))

    expect(res.status).toBe(200)
    expect(tasks).toHaveLength(1)
    await tasks[0]?.()
    expect(routed).toHaveLength(0)
  })

  it('routes one thread-keyed inbound per unresolved bot thread', async () => {
    const routed: InboundMessage[] = []
    const tasks: Array<() => Promise<void>> = []
    const handler = recheckHandler({
      fetchImpl: threadsFetch([
        {
          id: 'T1',
          isResolved: false,
          rootCommentId: 100,
          login: 'typeclaw-bot',
          path: 'src/api/auth.ts',
          line: 42,
          body: 'This token never expires — set a TTL.\nsecond line ignored',
        },
        { id: 'T2', isResolved: false, rootCommentId: 200, login: 'typeclaw-bot' },
        { id: 'T_DONE', isResolved: true, rootCommentId: 300, login: 'typeclaw-bot' },
      ]),
      routed,
      tasks,
    })

    await handler(signedRequest(JSON.stringify(synchronizePayload('deadbeef999')), 'pull_request', 'sync-some'))
    await tasks[0]?.()

    expect(routed).toHaveLength(2)
    expect(routed.map((msg) => msg.thread)).toEqual(['100', '200'])
    expect(routed.every((msg) => msg.chat === 'pr:7')).toBe(true)
    expect(routed.every((msg) => msg.isBotMention)).toBe(true)
    expect(routed.every((msg) => msg.workspace === 'acme/project')).toBe(true)

    const first = routed[0]!
    expect(first.text).toContain('PR #7')
    expect(first.text).toContain('deadbee')
    expect(first.text).toContain('thread 100 on src/api/auth.ts:42')
    expect(first.text).toContain('This token never expires — set a TTL.')
    expect(first.text).not.toContain('thread 200')
    expect(first.text).not.toContain('second line ignored')
    expect(first.externalMessageId).toBe('pr-7-recheck-deadbeef999-thread-100')
    expect(first.text).toContain('end your turn without replying')

    const second = routed[1]!
    expect(second.text).toContain('thread 200')
    expect(second.text).not.toContain('thread 100')
    expect(second.externalMessageId).toBe('pr-7-recheck-deadbeef999-thread-200')
  })

  it('does not route a self-authored synchronize (bot pushed its own PR)', async () => {
    const routed: InboundMessage[] = []
    const tasks: Array<() => Promise<void>> = []
    const handler = recheckHandler({
      fetchImpl: threadsFetch([{ id: 'T1', isResolved: false, rootCommentId: 100, login: 'typeclaw-bot' }]),
      routed,
      tasks,
    })
    const payload = synchronizePayload()
    payload.sender = { login: 'typeclaw-bot[bot]', id: 99, type: 'Bot' }

    await handler(signedRequest(JSON.stringify(payload), 'pull_request', 'sync-self'))

    expect(tasks).toHaveLength(0)
    expect(routed).toHaveLength(0)
  })

  it('does not schedule a synchronize excluded by the event allowlist', async () => {
    const routed: InboundMessage[] = []
    const tasks: Array<() => Promise<void>> = []
    const handler = createGithubWebhookHandler({
      webhookSecret: 'secret',
      dedup: createDeliveryDedup(),
      allowlist: () => [],
      selfId: () => '99',
      selfLogin: () => 'typeclaw-bot[bot]',
      authToken: async () => 'tok',
      scheduleBackgroundTask: (task) => {
        tasks.push(task)
      },
      logger,
      route: async (msg) => {
        routed.push(msg)
        return { kind: 'observed' as const }
      },
    })

    await handler(signedRequest(JSON.stringify(synchronizePayload()), 'pull_request', 'sync-not-allowed'))

    expect(tasks).toHaveLength(0)
    expect(routed).toHaveLength(0)
  })

  it('dedups a successful synchronize redelivery with the same delivery id', async () => {
    const routed: InboundMessage[] = []
    const tasks: Array<() => Promise<void>> = []
    const dedup = createDeliveryDedup()
    const handler = createGithubWebhookHandler({
      webhookSecret: 'secret',
      dedup,
      allowlist: () => ['pull_request.synchronize'],
      selfId: () => '99',
      selfLogin: () => 'typeclaw-bot[bot]',
      authType: () => 'app',
      authToken: async () => 'tok',
      fetchImpl: threadsFetch([{ id: 'T1', isResolved: false, rootCommentId: 100, login: 'typeclaw-bot' }]),
      scheduleBackgroundTask: (task) => {
        tasks.push(task)
      },
      logger,
      route: async (msg) => {
        routed.push(msg)
        return { kind: 'observed' as const }
      },
    })

    const body = JSON.stringify(synchronizePayload())
    await handler(signedRequest(body, 'pull_request', 'sync-dup'))
    await tasks[0]?.()
    await handler(signedRequest(body, 'pull_request', 'sync-dup'))

    expect(tasks).toHaveLength(1)
    expect(routed).toHaveLength(1)
  })

  it('warns and does not route when the thread listing fails', async () => {
    const routed: InboundMessage[] = []
    const tasks: Array<() => Promise<void>> = []
    const warns: string[] = []
    const handler = recheckHandler({
      fetchImpl: fakeFetch(() => new Response('boom', { status: 500 })),
      routed,
      tasks,
      warns,
    })

    await handler(signedRequest(JSON.stringify(synchronizePayload()), 'pull_request', 'sync-fail'))
    await tasks[0]?.()

    expect(routed).toHaveLength(0)
    expect(warns.some((w) => w.includes('review-thread recheck failed'))).toBe(true)
  })

  it('retries a failed thread-list lookup within one scheduled followup', async () => {
    const routed: InboundMessage[] = []
    const tasks: Array<() => Promise<void>> = []
    const sleeps: number[] = []
    let calls = 0
    const handler = recheckHandler({
      fetchImpl: fakeFetch((url) => {
        if (url.includes('/reviews')) return reviewsResponse([])
        calls++
        if (calls === 1) return new Response('boom', { status: 500 })
        return threadsResponse([{ id: 'T1', isResolved: false, rootCommentId: 100, login: 'typeclaw-bot' }])
      }),
      routed,
      tasks,
      sleepImpl: async (ms) => {
        sleeps.push(ms)
      },
    })

    await handler(signedRequest(JSON.stringify(synchronizePayload('retry-sha')), 'pull_request', 'sync-retry'))
    await tasks[0]?.()

    expect(tasks).toHaveLength(1)
    expect(calls).toBe(2)
    expect(sleeps).toEqual([1000])
    expect(routed).toHaveLength(1)
    expect(routed[0]?.thread).toBe('100')
  })

  it('bounds failed followup retries for a persistently failing repo', async () => {
    const routed: InboundMessage[] = []
    const tasks: Array<() => Promise<void>> = []
    const warns: string[] = []
    const sleeps: number[] = []
    let calls = 0
    const handler = recheckHandler({
      fetchImpl: fakeFetch(() => {
        calls++
        return new Response('boom', { status: 500 })
      }),
      routed,
      tasks,
      warns,
      sleepImpl: async (ms) => {
        sleeps.push(ms)
      },
    })

    await handler(
      signedRequest(JSON.stringify(synchronizePayload('always-fails')), 'pull_request', 'sync-always-fails'),
    )
    await tasks[0]?.()

    expect(tasks).toHaveLength(1)
    expect(calls).toBe(3)
    expect(sleeps).toEqual([1000, 2000])
    expect(routed).toHaveLength(0)
    expect(warns.some((warning) => warning.includes('retry cap exhausted') && warning.includes('acme/project#7'))).toBe(
      true,
    )
  })

  it('re-reviews a held CHANGES_REQUESTED even with no unresolved threads', async () => {
    const routed: InboundMessage[] = []
    const tasks: Array<() => Promise<void>> = []
    const handler = recheckHandler({
      fetchImpl: followupFetch({ threads: [], reviews: [{ state: 'CHANGES_REQUESTED' }] }),
      routed,
      tasks,
    })

    await handler(signedRequest(JSON.stringify(synchronizePayload('beef111')), 'pull_request', 'sync-cr'))
    await tasks[0]?.()

    expect(routed).toHaveLength(1)
    const msg = routed[0]!
    expect(msg.chat).toBe('pr:7')
    expect(msg.isBotMention).toBe(true)
    expect(msg.text).toContain('CHANGES_REQUESTED')
    expect(msg.text).toContain('beef111')
    expect(msg.externalMessageId).toBe('pr-7-recheck-beef111')
    // A held block never self-clears, so the inbound must demand a fresh verdict
    // and must NOT offer the silent-exit escape hatch that would strand the block.
    expect(msg.text).toContain('always end with a new verdict')
    expect(msg.text).toContain('DISMISS')
    expect(msg.text).not.toContain('COMMENT if approval is disabled')
    expect(msg.text).not.toContain('end your turn without replying')
  })

  it('does not append COMMENT-instead-of-APPROVE guidance to a blocking round when approval is disabled', async () => {
    const routed: InboundMessage[] = []
    const tasks: Array<() => Promise<void>> = []
    const handler = recheckHandler({
      fetchImpl: followupFetch({ threads: [], reviews: [{ state: 'CHANGES_REQUESTED' }] }),
      routed,
      tasks,
      allowApprove: false,
    })

    await handler(signedRequest(JSON.stringify(synchronizePayload('beef222')), 'pull_request', 'sync-cr-noapprove'))
    await tasks[0]?.()

    expect(routed).toHaveLength(1)
    // The policy note is appended AFTER the follow-up instruction, so the generic
    // wording would be the LAST directive the model reads and would override the
    // dismissal. Assert the whole routed text, not just the instruction fragment.
    const text = routed[0]!.text
    expect(text).toContain('DISMISS')
    expect(text).not.toContain('submit a `COMMENT` review instead of `APPROVE`')
    expect(text).toContain('does not clear the block')
  })

  it('does not route when the latest self review is APPROVED and no threads remain', async () => {
    const routed: InboundMessage[] = []
    const tasks: Array<() => Promise<void>> = []
    const handler = recheckHandler({
      fetchImpl: followupFetch({
        threads: [],
        reviews: [{ state: 'CHANGES_REQUESTED' }, { state: 'APPROVED' }],
      }),
      routed,
      tasks,
    })

    await handler(signedRequest(JSON.stringify(synchronizePayload()), 'pull_request', 'sync-approved'))
    await tasks[0]?.()

    expect(routed).toHaveLength(0)
  })

  it('delivers a held CHANGES_REQUESTED obligation through one sibling thread inbound', async () => {
    const routed: InboundMessage[] = []
    const tasks: Array<() => Promise<void>> = []
    const handler = recheckHandler({
      fetchImpl: followupFetch({
        threads: [{ id: 'T1', isResolved: false, rootCommentId: 100, login: 'typeclaw-bot' }],
        reviews: [{ state: 'CHANGES_REQUESTED' }],
      }),
      routed,
      tasks,
    })

    await handler(signedRequest(JSON.stringify(synchronizePayload()), 'pull_request', 'sync-both'))
    await tasks[0]?.()

    expect(routed).toHaveLength(1)
    expect(routed[0]!.thread).toBe('100')
    expect(routed[0]!.text).toContain('100')
    expect(routed[0]!.text).toContain('CHANGES_REQUESTED')
    expect(routed[0]!.text).not.toContain('end your turn without replying')
    expect(routed[0]!.githubReviewRound).toEqual({
      kind: 'push',
      roundId: 'round-id',
      workspace: 'acme/project',
      prNumber: 7,
      headSha: 'abc1234def',
      carrierThread: '100',
    })
  })

  it('stamps every sibling inbound with one carrier-scoped round identity', async () => {
    const routed: InboundMessage[] = []
    const tasks: Array<() => Promise<void>> = []
    const handler = recheckHandler({
      fetchImpl: followupFetch({
        threads: [
          { id: 'T1', isResolved: false, rootCommentId: 100, login: 'typeclaw-bot' },
          { id: 'T2', isResolved: false, rootCommentId: 200, login: 'typeclaw-bot' },
        ],
        reviews: [{ state: 'CHANGES_REQUESTED' }],
      }),
      routed,
      tasks,
    })

    await handler(signedRequest(JSON.stringify(synchronizePayload('round-sha')), 'pull_request', 'sync-round'))
    await tasks[0]?.()

    expect(routed.map((message) => message.githubReviewRound)).toEqual([
      {
        kind: 'push',
        roundId: 'round-id',
        workspace: 'acme/project',
        prNumber: 7,
        headSha: 'round-sha',
        carrierThread: '100',
      },
      {
        kind: 'push',
        roundId: 'round-id',
        workspace: 'acme/project',
        prNumber: 7,
        headSha: 'round-sha',
        carrierThread: '100',
      },
    ])
  })

  it('skips the CHANGES_REQUESTED re-review when review.on is off', async () => {
    const routed: InboundMessage[] = []
    const tasks: Array<() => Promise<void>> = []
    const handler = createGithubWebhookHandler({
      webhookSecret: 'secret',
      dedup: createDeliveryDedup(),
      allowlist: () => ['pull_request.synchronize'],
      selfId: () => '99',
      selfLogin: () => 'typeclaw-bot[bot]',
      authType: () => 'app',
      reviewOn: () => 'off',
      authToken: async () => 'tok',
      fetchImpl: followupFetch({ threads: [], reviews: [{ state: 'CHANGES_REQUESTED' }] }),
      scheduleBackgroundTask: (task) => {
        tasks.push(task)
      },
      logger,
      route: async (msg) => {
        routed.push(msg)
        return { kind: 'observed' as const }
      },
    })

    await handler(signedRequest(JSON.stringify(synchronizePayload()), 'pull_request', 'sync-off'))
    await tasks[0]?.()

    expect(routed).toHaveLength(0)
  })

  it('keeps thread-only followups round-free when review.on is off', async () => {
    const routed: InboundMessage[] = []
    const tasks: Array<() => Promise<void>> = []
    const handler = recheckHandler({
      reviewOn: 'off',
      fetchImpl: followupFetch({
        threads: [{ id: 'T1', isResolved: false, rootCommentId: 100, login: 'typeclaw-bot' }],
        reviews: [{ state: 'CHANGES_REQUESTED' }],
      }),
      routed,
      tasks,
    })

    await handler(signedRequest(JSON.stringify(synchronizePayload('off-sha')), 'pull_request', 'sync-off-thread'))
    await tasks[0]?.()

    expect(routed).toHaveLength(1)
    expect(routed[0]!.githubReviewRound).toBeUndefined()
  })

  it('reserves a same-sha followup synchronously across concurrent deliveries', async () => {
    const routed: InboundMessage[] = []
    const tasks: Array<() => Promise<void>> = []
    const dedup = createDeliveryDedup()
    const handler = createGithubWebhookHandler({
      webhookSecret: 'secret',
      dedup,
      allowlist: () => ['pull_request.synchronize'],
      selfId: () => '99',
      selfLogin: () => 'typeclaw-bot[bot]',
      authType: () => 'app',
      authToken: async () => 'tok',
      fetchImpl: followupFetch({ reviews: [{ state: 'CHANGES_REQUESTED' }] }),
      scheduleBackgroundTask: (task) => {
        tasks.push(task)
      },
      logger,
      route: async (msg) => {
        routed.push(msg)
        return { kind: 'observed' as const }
      },
    })

    const body = JSON.stringify(synchronizePayload('samesha777'))
    await Promise.all([
      handler(signedRequest(body, 'pull_request', 'sync-sha-1')),
      handler(signedRequest(body, 'pull_request', 'sync-sha-2')),
    ])

    expect(tasks).toHaveLength(1)
    await tasks[0]?.()
    expect(routed).toHaveLength(1)
  })

  it('runs the followup again for a new head sha', async () => {
    const routed: InboundMessage[] = []
    const tasks: Array<() => Promise<void>> = []
    const dedup = createDeliveryDedup()
    const handler = createGithubWebhookHandler({
      webhookSecret: 'secret',
      dedup,
      allowlist: () => ['pull_request.synchronize'],
      selfId: () => '99',
      selfLogin: () => 'typeclaw-bot[bot]',
      authType: () => 'app',
      authToken: async () => 'tok',
      fetchImpl: followupFetch({ reviews: [{ state: 'CHANGES_REQUESTED' }] }),
      scheduleBackgroundTask: (task) => {
        tasks.push(task)
      },
      logger,
      route: async (msg) => {
        routed.push(msg)
        return { kind: 'observed' as const }
      },
    })

    await handler(signedRequest(JSON.stringify(synchronizePayload('sha-aaa')), 'pull_request', 'sync-new-1'))
    await handler(signedRequest(JSON.stringify(synchronizePayload('sha-bbb')), 'pull_request', 'sync-new-2'))

    expect(tasks).toHaveLength(2)
  })

  it('bounds completed followup reservations across many distinct head shas', async () => {
    const routed: InboundMessage[] = []
    const tasks: Array<() => Promise<void>> = []
    const handler = recheckHandler({ fetchImpl: followupFetch({}), routed, tasks })

    for (let index = 0; index <= 1000; index++) {
      const sha = `sha-${index}`
      await handler(signedRequest(JSON.stringify(synchronizePayload(sha)), 'pull_request', `sync-cap-${index}`))
      await tasks[index]?.()
    }

    expect(tasks).toHaveLength(1001)

    await handler(
      signedRequest(JSON.stringify(synchronizePayload('sha-1000')), 'pull_request', 'sync-cap-latest-redelivery'),
    )
    expect(tasks).toHaveLength(1001)

    await handler(
      signedRequest(JSON.stringify(synchronizePayload('sha-0')), 'pull_request', 'sync-cap-oldest-redelivery'),
    )
    expect(tasks).toHaveLength(1002)
  })

  it('skips the followup when the synchronize carries no head sha', async () => {
    const routed: InboundMessage[] = []
    const tasks: Array<() => Promise<void>> = []
    const warns: string[] = []
    const payload = synchronizePayload()
    const pr = payload.pull_request as Record<string, unknown>
    pr.head = { ref: 'feature' }
    const handler = recheckHandler({
      fetchImpl: followupFetch({ reviews: [{ state: 'CHANGES_REQUESTED' }] }),
      routed,
      tasks,
      warns,
    })

    await handler(signedRequest(JSON.stringify(payload), 'pull_request', 'sync-no-sha'))

    expect(tasks).toHaveLength(0)
    expect(routed).toHaveLength(0)
    expect(warns.some((w) => w.includes('no head sha'))).toBe(true)
  })

  it('retries the whole followup when review-state lookup fails with unresolved threads', async () => {
    const routed: InboundMessage[] = []
    const tasks: Array<() => Promise<void>> = []
    const warns: string[] = []
    const sleeps: number[] = []
    let reviewCalls = 0
    const handler = recheckHandler({
      fetchImpl: fakeFetch((url) => {
        if (url.includes('/reviews')) {
          reviewCalls++
          return reviewCalls === 1
            ? new Response('boom', { status: 500 })
            : reviewsResponse([{ state: 'CHANGES_REQUESTED' }])
        }
        return threadsResponse([{ id: 'T1', isResolved: false, rootCommentId: 100, login: 'typeclaw-bot' }])
      }),
      routed,
      tasks,
      warns,
      sleepImpl: async (ms) => {
        sleeps.push(ms)
      },
    })

    await handler(
      signedRequest(JSON.stringify(synchronizePayload('state-retry-sha')), 'pull_request', 'sync-state-fail'),
    )
    await tasks[0]?.()

    expect(warns.some((w) => w.includes('review-state recheck failed'))).toBe(true)
    expect(tasks).toHaveLength(1)
    expect(reviewCalls).toBe(2)
    expect(sleeps).toEqual([1000])
    expect(routed).toHaveLength(1)
    expect(routed[0]!.text).toContain('CHANGES_REQUESTED')
  })
})

describe('createGithubWebhookHandler — allowApprove policy note', () => {
  const baseOptions = (routed: InboundMessage[], allowApprove?: () => boolean): GithubWebhookHandlerOptions => ({
    webhookSecret: 'secret',
    dedup: createDeliveryDedup(),
    allowlist: () => ['pull_request.review_requested', 'issue_comment.created'],
    selfId: () => '99',
    selfLogin: () => 'typeclaw-bot',
    logger,
    route: async (msg) => {
      routed.push(msg)
      return { kind: 'observed' as const }
    },
    ...(allowApprove !== undefined ? { allowApprove } : {}),
  })

  it('does not append the note when approval is allowed (review_requested)', async () => {
    const routed: InboundMessage[] = []
    const handler = createGithubWebhookHandler(baseOptions(routed, () => true))
    await handler(
      signedRequest(JSON.stringify(reviewRequestedPayload({ reviewerLogin: 'typeclaw-bot' })), 'pull_request', 'd1'),
    )
    expect(routed[0]?.text).toContain('requested your review on PR #7')
    expect(routed[0]?.text).not.toContain(PR_APPROVAL_DISABLED_NOTE)
  })

  it('does not append the note when allowApprove is omitted (defaults to allowed)', async () => {
    const routed: InboundMessage[] = []
    const handler = createGithubWebhookHandler(baseOptions(routed))
    await handler(
      signedRequest(JSON.stringify(reviewRequestedPayload({ reviewerLogin: 'typeclaw-bot' })), 'pull_request', 'd2'),
    )
    expect(routed[0]?.text).not.toContain(PR_APPROVAL_DISABLED_NOTE)
  })

  it('appends the note to a review_requested inbound when approval is disabled', async () => {
    const routed: InboundMessage[] = []
    const handler = createGithubWebhookHandler(baseOptions(routed, () => false))
    await handler(
      signedRequest(JSON.stringify(reviewRequestedPayload({ reviewerLogin: 'typeclaw-bot' })), 'pull_request', 'd3'),
    )
    expect(routed[0]?.text).toContain('requested your review on PR #7')
    expect(routed[0]?.text).toContain(PR_APPROVAL_DISABLED_NOTE)
  })

  it('appends the note to a plain-language inbound (issue comment) when approval is disabled', async () => {
    const routed: InboundMessage[] = []
    const handler = createGithubWebhookHandler(baseOptions(routed, () => false))
    await handler(signedRequest(JSON.stringify(issueCommentPayload({ pullRequest: true })), 'issue_comment', 'd4'))
    expect(routed[0]?.chat).toBe('pr:7')
    expect(routed[0]?.text).toContain('@typeclaw-bot hello')
    expect(routed[0]?.text).toContain(PR_APPROVAL_DISABLED_NOTE)
  })
})

function signedRequest(body: string, event: string, delivery: string): Request {
  const sig = `sha256=${createHmac('sha256', 'secret').update(body).digest('hex')}`
  return new Request('https://example.com/github', {
    method: 'POST',
    headers: {
      'x-hub-signature-256': sig,
      'x-github-event': event,
      'x-github-delivery': delivery,
    },
    body,
  })
}

function repo(): Record<string, unknown> {
  return { name: 'project', owner: { login: 'acme' } }
}

function user(): Record<string, unknown> {
  return { login: 'alice', id: 10, type: 'User' }
}

function issueCommentPayload(options: { pullRequest: boolean; body?: string }): Record<string, unknown> {
  return {
    action: 'created',
    repository: repo(),
    issue: { number: 7, ...(options.pullRequest ? { pull_request: {} } : {}) },
    comment: {
      id: 99,
      body: options.body ?? '@typeclaw-bot hello',
      created_at: '2026-01-01T00:00:00Z',
      user: user(),
    },
  }
}

function reviewCommentPayload(
  options: {
    inReplyToId?: number | null
    body?: string
    id?: number
    prNumber?: number
    headSha?: string
  } = {},
): Record<string, unknown> {
  const inReplyToId = options.inReplyToId === undefined ? 101 : options.inReplyToId
  return {
    action: 'created',
    repository: repo(),
    pull_request: {
      number: options.prNumber ?? 7,
      ...(options.headSha !== undefined ? { head: { sha: options.headSha } } : {}),
    },
    comment: {
      id: options.id ?? 102,
      ...(inReplyToId !== null ? { in_reply_to_id: inReplyToId } : {}),
      body: options.body ?? 'review',
      created_at: '2026-01-01T00:00:00Z',
      user: user(),
    },
  }
}

function pullRequestForReview(updatedAt: string): Record<string, unknown> {
  return {
    number: 7,
    id: 700,
    title: 'Add the thing',
    updated_at: updatedAt,
    head: { ref: 'feat-branch' },
    base: { ref: 'main' },
    user: user(),
  }
}

function openedPayload(options: { updatedAt?: string; draft?: boolean } = {}): Record<string, unknown> {
  const pull_request = pullRequestForReview(options.updatedAt ?? '2026-01-01T00:00:00Z')
  if (options.draft !== undefined) pull_request.draft = options.draft
  return {
    action: 'opened',
    repository: repo(),
    pull_request,
    sender: { login: 'alice', id: 10, type: 'User' },
  }
}

function readyForReviewPayload(options: { updatedAt?: string; draft?: boolean } = {}): Record<string, unknown> {
  const pull_request = pullRequestForReview(options.updatedAt ?? '2026-01-01T00:00:00Z')
  // ready_for_review fires on the draft→ready transition, so draft is false by then.
  pull_request.draft = options.draft ?? false
  return {
    action: 'ready_for_review',
    repository: repo(),
    pull_request,
    sender: { login: 'alice', id: 10, type: 'User' },
  }
}

function convertedToDraftPayload(
  options: { owner?: string; name?: string; prNumber?: number; prId?: number } = {},
): Record<string, unknown> {
  return {
    action: 'converted_to_draft',
    repository: { name: options.name ?? 'project', owner: { login: options.owner ?? 'acme' } },
    pull_request: {
      number: options.prNumber ?? 7,
      id: options.prId ?? 700,
      draft: true,
      user: user(),
    },
    sender: user(),
  }
}

function reviewRequestedPayload(options: {
  reviewerLogin: string
  updatedAt?: string
  draft?: boolean
}): Record<string, unknown> {
  const pull_request = pullRequestForReview(options.updatedAt ?? '2026-01-01T00:00:00Z')
  if (options.draft !== undefined) pull_request.draft = options.draft
  return {
    action: 'review_requested',
    repository: repo(),
    pull_request,
    requested_reviewer: { login: options.reviewerLogin, id: 42, type: 'User' },
    sender: { login: 'alice', id: 10, type: 'User' },
  }
}

function reviewRequestRemovedPayload(options: { reviewerLogin: string; updatedAt?: string }): Record<string, unknown> {
  return {
    action: 'review_request_removed',
    repository: repo(),
    pull_request: pullRequestForReview(options.updatedAt ?? '2026-01-01T00:01:00Z'),
    requested_reviewer: { login: options.reviewerLogin, id: 42, type: 'User' },
    sender: { login: 'alice', id: 10, type: 'User' },
  }
}

function reviewRequestedTeamPayload(): Record<string, unknown> {
  return {
    action: 'review_requested',
    repository: repo(),
    pull_request: pullRequestForReview('2026-01-01T00:00:00Z'),
    requested_team: { slug: 'reviewers', id: 5000 },
    sender: { login: 'alice', id: 10, type: 'User' },
  }
}
