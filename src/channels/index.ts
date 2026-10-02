export { createChannelManager, type ChannelManager, type ChannelManagerOptions } from './manager'
export {
  createGithubTokenBridge,
  type GithubTokenBridge,
  type GithubTokenResolveResult,
  type ResolveGithubTokenForRepo,
} from './github-token-bridge'
export {
  createChannelRouter,
  type ChannelRouter,
  type ClaimHandler,
  type ClaimHandlerInput,
  type ClaimHandlerOutcome,
  type CreateChannelRouterOptions,
  type CreateSessionForChannel,
} from './router'
export { createChannelsReloadable } from './reloadable'
export {
  createPrVerdictActivityBridge,
  type PrVerdictActivityBridge,
  type PrVerdictActivityBridgeOptions,
} from './pr-verdict-activity-bridge'
export {
  setReviewObserver,
  setReviewOutputObserver,
  setReviewCoverageCapture,
  type ReviewOutputState,
} from './github-review-turn-ledger'
export {
  createSubagentCompletionBridge,
  type SubagentCompletionBridge,
  type SubagentCompletionBridgeOptions,
} from './subagent-completion-bridge'
export {
  channelsSchema,
  ADAPTER_IDS,
  STICKY_DEFAULT_WINDOW_MS,
  type AdapterId,
  type ChannelAdapterConfig,
  type ChannelsConfig,
  type EngagementConfig,
} from './schema'
export type { ChannelKey, InboundMessage, OutboundCallback, OutboundMessage, SendResult } from './types'
export { channelKeyId } from './types'
