import type { Model } from '@shared/data/types/model'

export type ManagedChatPlatform = 'gemini' | 'claude'
export interface ManagedModelControls {
  channel: 'claude_code_subscription_chat'
  thinking: {
    mode: 'adaptive' | 'adaptive_or_budget' | 'budget'
    canDisable: boolean
    effortLevels: Array<'low' | 'medium' | 'high' | 'xhigh' | 'max'>
    defaultEffort: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  }
}

export interface ManagedChatSession {
  Id: string
  Title: string
  Model: string
  Draft?: string
  Turns: Array<{ User: string; Assistant: string; State: string; Error: string }>
}

export interface ManagedChatChannel {
  platform: ManagedChatPlatform
  key: string
  model: string
  models: Array<{ id: string; label: string; controls?: ManagedModelControls }>
  sessions: ManagedChatSession[]
  channel: string
  selectedId?: string
  catalogError?: boolean
}
export interface ManagedChatConfig {
  platform: 'shared'
  server: string
  group: string
  entryPlatform: ManagedChatPlatform
  channels: ManagedChatChannel[]
}

let current: ManagedChatConfig | null = null

export function setManagedChatConfig(config: ManagedChatConfig): void {
  const server = new URL(config.server)
  if (
    config.platform !== 'shared' ||
    !/^[a-f0-9]{32}$/.test(config.group) ||
    !['http:', 'https:'].includes(server.protocol)
  ) {
    throw new Error('Invalid managed platform or gateway')
  }
  if (server.username || server.password || server.search || server.hash || server.pathname !== '/') {
    throw new Error('Managed gateway must be a root URL')
  }
  if (/\.(anthropic\.com|claude\.com|googleapis\.com|google\.com)$/i.test('.' + server.hostname)) {
    throw new Error('A distributed key cannot be sent to an official upstream host')
  }
  if (
    !config.channels?.length ||
    config.channels.some(
      (item) => !['gemini', 'claude'].includes(item.platform) || !item.key || /[\r\n]/.test(item.key)
    )
  ) {
    throw new Error('Invalid managed key or selected model')
  }
  if (new Set(config.channels.map((item) => item.platform)).size !== config.channels.length)
    throw new Error('Duplicate managed platform')
  current = { ...config, server: server.origin }
}

export function getManagedChatConfig(): ManagedChatConfig | null {
  return current
}

export function getManagedCredential(providerId: string): string | undefined {
  return current?.channels.find((item) => providerId === 'api-' + item.platform)?.key
}

export function getManagedModelControls(model: Pick<Model, 'providerId' | 'apiModelId'>): ManagedModelControls | undefined {
  if (!process.env.API_CHAT_BUILD || model.providerId !== 'api-claude') return undefined
  return current?.channels.find((item) => item.platform === 'claude')?.models.find((item) => item.id === model.apiModelId)?.controls
}

export function applyManagedModelControls(model: Model): Model {
  const controls = getManagedModelControls(model)
  if (!controls) return model
  const { thinking } = controls
  const reasoning = thinking.effortLevels.length
    ? {
        ...model.reasoning,
        controls: [
          { kind: 'effort' as const, values: thinking.effortLevels, default: thinking.defaultEffort },
          ...(thinking.canDisable ? [{ kind: 'toggle' as const }] : [])
        ],
        supportedEfforts: [...thinking.effortLevels, ...(thinking.canDisable ? ['none' as const] : [])],
        selectableEfforts: [...thinking.effortLevels, ...(thinking.canDisable ? ['none' as const] : [])],
        defaultEffort: thinking.defaultEffort
      }
    : model.reasoning
  return {
    ...model,
    reasoning,
    parameterSupport: {
      ...model.parameterSupport,
      temperature: { supported: false, min: 0, max: 1 },
      topP: { supported: false, min: 0, max: 1 },
      topK: { supported: false, min: 0, max: 100 },
      maxTokens: true,
      systemMessage: true,
      stopSequences: false
    }
  }
}

export function getManagedChatName(): string {
  return 'Claude · Gemini'
}
