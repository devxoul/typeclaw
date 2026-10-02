import { z } from 'zod'

import type { RecoveryAdapterCallbacks } from '../../types'
import { recoveryMarker } from '../recovery-correlation'
import type { GithubAuthStrategy } from './auth'
import { githubJsonHeaders } from './auth-pat'

const commentSchema = z.object({
  id: z.number(),
  body: z.string().nullable(),
  user: z.object({ id: z.number() }).nullable(),
  in_reply_to_id: z.number().optional(),
})
const discussionSchema = z.object({
  data: z.object({
    repository: z
      .object({
        discussion: z
          .object({
            comments: z.object({
              nodes: z.array(
                z.object({
                  databaseId: z.number(),
                  body: z.string(),
                  author: z.object({ login: z.string() }).nullable(),
                }),
              ),
              pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
            }),
          })
          .nullable(),
      })
      .nullable(),
  }),
  errors: z.array(z.unknown()).optional(),
})

export function createGithubRecoveryCallbacks(
  auth: GithubAuthStrategy,
  fetchImpl: typeof fetch = fetch,
  cachedAccountIdentity: () => string | undefined = () => undefined,
): RecoveryAdapterCallbacks {
  return {
    cachedAccountIdentity,
    async accountIdentity() {
      return `github:${(await auth.getSelf()).id}`
    },
    async reconcile(record) {
      const self = await auth.getSelf()
      if (`github:${self.id}` !== (record.boundAccountIdentity ?? record.accountIdentity))
        throw new Error('recovery-account-identity-changed')
      const { workspace, chat, thread } = record.target
      const match = /^(issue|pr|discussion):(\d+)$/.exec(chat)
      if (!match || !/^[^/]+\/[^/]+$/.test(workspace)) throw new Error('invalid-recovery-github-target')
      if (match[1] !== 'pr' && thread !== null) throw new Error('invalid-recovery-github-thread')
      const headers = githubJsonHeaders(await auth.token({ repoSlug: workspace }))
      const marker = recoveryMarker(record.deliveryId)
      if (match[1] === 'discussion') {
        const [owner, name] = workspace.split('/')
        let cursor: string | null = null
        const seen = new Set<string>()
        do {
          const response = await fetchImpl('https://api.github.com/graphql', {
            method: 'POST',
            headers,
            body: JSON.stringify({
              query:
                'query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){discussion(number:$number){comments(first:100,after:$cursor){nodes{databaseId body author{login}} pageInfo{hasNextPage endCursor}}}}}',
              variables: { owner, name, number: Number(match[2]), cursor },
            }),
          })
          if (!response.ok) throw new Error(`recovery-history-${response.status}`)
          const result = discussionSchema.parse(await response.json())
          if (result.errors?.length) throw new Error('recovery-history-graphql-error')
          const comments = result.data.repository?.discussion?.comments
          if (!comments) throw new Error('recovery-destination-unavailable')
          const found = comments.nodes.find((row) => row.author?.login === self.login && row.body.includes(marker))
          if (found) return { status: 'found', messageId: String(found.databaseId) }
          cursor = comments.pageInfo.hasNextPage ? comments.pageInfo.endCursor : null
          if (comments.pageInfo.hasNextPage && !cursor) throw new Error('recovery-history-missing-cursor')
          if (cursor && seen.has(cursor)) throw new Error('recovery-history-cursor-loop')
          if (cursor) seen.add(cursor)
        } while (cursor)
      } else {
        const review = match[1] === 'pr' && !!thread
        for (let page = 1; ; page++) {
          const response = await fetchImpl(
            `https://api.github.com/repos/${workspace}/${review ? 'pulls' : 'issues'}/${match[2]}/comments?per_page=100&page=${page}`,
            { headers },
          )
          if (!response.ok) throw new Error(`recovery-history-${response.status}`)
          const rows = z.array(commentSchema).parse(await response.json())
          const found = rows.find(
            (row) =>
              row.user?.id === self.id &&
              row.body?.includes(marker) &&
              (!review || String(row.in_reply_to_id) === thread),
          )
          if (found) return { status: 'found', messageId: String(found.id) }
          if (rows.length < 100) break
        }
      }
      return { status: 'unknown' }
    },
  }
}
