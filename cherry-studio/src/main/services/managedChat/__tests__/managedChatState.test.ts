import { describe, expect, it } from 'vitest'

import { applyManagedModelControls, getManagedCredential, setManagedChatConfig } from '../managedChatState'
import type { ManagedChatConfig } from '../managedChatState'
import type { Model } from '@shared/data/types/model'

function configuration(): ManagedChatConfig {
  return {
    platform: 'shared',
    server: 'http://raspberry5.local:1456',
    group: 'a'.repeat(32),
    entryPlatform: 'gemini',
    channels: [
      {
        platform: 'gemini',
        key: 'gemini-personal-fixture',
        model: 'catalog-gemini',
        models: [{ id: 'catalog-gemini', label: 'Gemini' }],
        sessions: [],
        channel: 'gemini_web'
      },
      {
        platform: 'claude',
        key: 'claude-personal-fixture',
        model: 'catalog-claude',
        models: [{ id: 'catalog-claude', label: 'Claude' }],
        sessions: [],
        channel: 'claude_messages'
      }
    ]
  }
}
describe('Cock distributed chat credentials', () => {
  it('projects CLI controls without changing another provider or offering unsupported sampling/off', () => {
    const previous = process.env.API_CHAT_BUILD
    process.env.API_CHAT_BUILD = '1'
    try {
      const config = configuration()
      config.channels[1].models[0].controls = {
        channel: 'claude_code_subscription_chat',
        thinking: { mode: 'adaptive', canDisable: false, effortLevels: ['low', 'medium', 'high'], defaultEffort: 'medium' }
      }
      setManagedChatConfig(config)
      const model = { providerId: 'api-claude', apiModelId: 'catalog-claude', capabilities: [] } as unknown as Model
      const projected = applyManagedModelControls(model)
      expect(projected.parameterSupport?.temperature?.supported).toBe(false)
      expect(projected.parameterSupport?.topP?.supported).toBe(false)
      expect(projected.reasoning?.selectableEfforts).toEqual(['low', 'medium', 'high'])
      expect(projected.reasoning?.controls?.some((control) => control.kind === 'toggle')).toBe(false)
      const other = { ...model, providerId: 'anthropic' }
      expect(applyManagedModelControls(other)).toBe(other)
    } finally {
      if (previous === undefined) delete process.env.API_CHAT_BUILD
      else process.env.API_CHAT_BUILD = previous
    }
  })
  it('keeps provider credentials independent and never supplies a distributed Key to an upstream preset', () => {
    setManagedChatConfig(configuration())
    expect(getManagedCredential('api-gemini')).toBe('gemini-personal-fixture')
    expect(getManagedCredential('api-claude')).toBe('claude-personal-fixture')
    expect(getManagedCredential('anthropic')).toBeUndefined()
    expect(getManagedCredential('google')).toBeUndefined()
    expect(getManagedCredential('openai')).toBeUndefined()
  })
  it.each(['https://api.anthropic.com', 'https://generativelanguage.googleapis.com', 'https://claude.com'])(
    'refuses sending a personal distributed Key to %s',
    (server) => {
      expect(() => setManagedChatConfig({ ...configuration(), server })).toThrow('official upstream')
    }
  )
  it.each([
    'http://raspberry5.local:1456/gemini',
    'http://name:password@raspberry5.local:1456',
    'http://raspberry5.local:1456?key=private'
  ])('refuses an invalid gateway root %s', (server) => {
    expect(() => setManagedChatConfig({ ...configuration(), server })).toThrow('root URL')
  })
  it('refuses duplicate platform credentials instead of replacing one silently', () => {
    const config = configuration()
    config.channels.push({ ...config.channels[0], key: 'another-user' })
    expect(() => setManagedChatConfig(config)).toThrow('Duplicate managed platform')
  })
})
