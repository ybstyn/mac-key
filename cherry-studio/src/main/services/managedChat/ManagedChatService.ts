import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { promisify } from 'node:util'

import { eq, inArray, sql } from 'drizzle-orm'
import { app, session } from 'electron'

import { application } from '@application'
import { notifyDataApiDataChange } from '@data/dataApiDataChange'
import { appStateTable } from '@data/db/schemas/appState'
import { topicTable } from '@data/db/schemas/topic'
import { assistantDataService } from '@data/services/AssistantService'
import { messageService } from '@data/services/MessageService'
import { modelService } from '@data/services/ModelService'
import { providerService } from '@data/services/ProviderService'
import { topicService } from '@data/services/TopicService'
import { loggerService } from '@logger'
import { BaseService, DependsOn, ErrorHandling, Injectable, Phase, ServicePhase } from '@main/core/lifecycle'
import { WindowType } from '@main/core/window/types'
import { DEFAULT_ASSISTANT_SETTINGS } from '@shared/data/types/assistant'
import { ENDPOINT_TYPE, MODALITY } from '@shared/data/types/model'
import type { OutputFor } from '@shared/ipc/types'

import {
  getManagedChatConfig,
  getManagedChatName,
  type ManagedModelControls,
  type ManagedChatChannel,
  type ManagedChatConfig,
  type ManagedChatPlatform,
  setManagedChatConfig
} from './managedChatState'

@Injectable('ManagedChatService')
@ServicePhase(Phase.WhenReady)
@DependsOn(['WindowManager'])
@ErrorHandling('fail-fast')
export class ManagedChatService extends BaseService {
  private directReady: Promise<void> | null = null
  private loading: Promise<void> | null = null
  private connectingKeys = false
  private presented = false
  protected async onInit(): Promise<void> {
    if (!process.env.API_CHAT_PROFILE) return
    await this.loadProvision()
    const reload = () => {
      void this.loadProvision().catch((error) =>
        loggerService.withContext('ManagedChat').error('Profile update failed', error)
      )
    }
    app.on('second-instance', reload)
    this.registerDisposable(() => app.removeListener('second-instance', reload))
  }
  private async loadProvision(): Promise<void> {
    if (this.loading) return this.loading
    const operation = (async () => {
      const file = application.getPath('feature.managed_chat.provision_file')
      if (!(await fs.stat(file).catch(() => null))) return
      const launcher = process.env.API_CHAT_LAUNCHER
      if (!launcher) throw new Error('Managed launcher is missing')
      const { stdout } = await promisify(execFile)(launcher, ['--chat-provision', file], {
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024,
        timeout: 30000
      })
      setManagedChatConfig(JSON.parse(stdout) as ManagedChatConfig)
      const config = getManagedChatConfig()!
      for (const channel of config.channels) {
        if (!channel.models.length || channel.platform === 'claude') {
          try {
            await this.readModels(channel)
          } catch (error) {
            if (channel.platform === config.entryPlatform) throw error
            channel.catalogError = true
            loggerService
              .withContext('ManagedChat')
              .warn('A secondary platform catalog is unavailable', { platform: channel.platform })
            continue
          }
        }
        this.configureChannel(channel)
      }
      const entry = config.channels.find((item) => item.platform === config.entryPlatform)!
      const selected = modelService
        .list({ providerId: 'api-' + entry.platform })
        .find((item) => item.apiModelId === entry.model)!
      const preference = application.get('PreferenceService')
      await preference.set('chat.default_model_id', selected.id)
      await preference.set('app.onboarding.provider_setup.status', 'completed')
      await preference.set('app.dist.auto_update.enabled', false)
      await preference.set('app.tray.enabled', true)
      await preference.set('app.tray.on_close', true)
      await preference.set('chat.retry.enabled', false)
      await preference.set('topic.naming.enabled', false)
      await preference.set('chat.input.toolbar.pinned_tools', ['composer:new-conversation'])
      await preference.set('chat.input.show_estimated_tokens', false)
      await preference.set('ui.sidebar_shortcut', [
        {
          id: 'sidebar-shortcut:core.app:assistants',
          type: 'shortcut',
          target: { kind: 'resource', locator: { providerId: 'core.app', resourceId: 'assistants' } }
        }
      ])
      const host = new URL(config.server).hostname
      const rules = preference
        .get('app.proxy.bypass_rules')
        .split(/[;,]/)
        .map((value) => value.trim())
        .filter(Boolean)
      for (const value of [host, '127.0.0.1', 'localhost', '::1'])
        if (!rules.some((item) => item.toLowerCase() === value.toLowerCase())) rules.push(value)
      await preference.set('app.proxy.bypass_rules', rules.join(','))
    })()
    this.loading = operation
    try {
      await operation
    } finally {
      this.loading = null
    }
  }
  async fetchGateway(path: string, init: RequestInit = {}): Promise<Response> {
    const config = getManagedChatConfig()!
    const target = new URL(path, config.server)
    if (target.origin !== config.server) throw new Error('Managed gateway origin mismatch')
    const direct = session.fromPartition('api-gateway-' + config.group)
    this.directReady ??= direct.setProxy({ mode: 'direct' })
    await this.directReady
    return direct.fetch(target.href, { ...init, redirect: 'error' })
  }
  private async readModels(channel: ManagedChatChannel): Promise<void> {
    const response = await this.fetchGateway(
      '/' + channel.platform + (channel.platform === 'claude' ? '/v1/models' : '/v1beta/models'),
      {
        headers: { [channel.platform === 'claude' ? 'x-api-key' : 'x-goog-api-key']: channel.key },
        signal: AbortSignal.timeout(15000)
      }
    )
    if (!response.ok) throw new Error('Model catalog HTTP ' + response.status)
    const body = await response.json()
    const rows = channel.platform === 'claude' ? body.data : body.models
    channel.models = (Array.isArray(rows) ? rows : [])
      .map((row: Record<string, unknown>) => ({
        id: String(row.id || row.name || '').replace(/^models\//, ''),
        label: String(row.display_name || row.displayName || row.id || row.name || ''),
        ...((row.cockpit as ManagedModelControls | undefined)?.channel === 'claude_code_subscription_chat'
          ? { controls: row.cockpit as ManagedModelControls }
          : {})
      }))
      .filter((row: { id: string }) => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(row.id))
    if (!channel.models.length) throw new Error('This Key has no available models')
    if (!channel.models.some((item) => item.id === channel.model)) channel.model = channel.models[0].id
  }
  private configureChannel(channel: ManagedChatChannel): void {
    const config = getManagedChatConfig()!,
      providerId = 'api-' + channel.platform
    const endpoint =
      channel.platform === 'claude' ? ENDPOINT_TYPE.ANTHROPIC_MESSAGES : ENDPOINT_TYPE.GOOGLE_GENERATE_CONTENT
    const baseUrl = config.server + '/' + channel.platform + (channel.platform === 'claude' ? '/v1' : '/v1beta')
    if (!providerService.list({}).some((provider) => provider.id === providerId))
      providerService.create({
        providerId,
        name: channel.platform === 'claude' ? 'Claude' : 'Gemini',
        logo: { kind: 'key', key: channel.platform === 'claude' ? 'anthropic' : 'gemini' },
        defaultChatEndpoint: endpoint,
        endpointConfigs: { [endpoint]: { baseUrl } },
        apiKeys: [{ id: 'api-managed', key: 'managed-by-api', isEnabled: true }],
        authConfig: { type: 'api-key' }
      })
    providerService.update(providerId, { isEnabled: true, endpointConfigs: { [endpoint]: { baseUrl } } })
    const known = modelService.list({ providerId })
    const create = channel.models.filter((row) => !known.some((item) => item.apiModelId === row.id))
    if (create.length)
      modelService.create(
        create.map((row) => ({
          dto: {
            providerId,
            modelId: row.id,
            name: row.label,
            endpointTypes: [endpoint],
            supportsStreaming: true,
            inputModalities: [MODALITY.TEXT],
            outputModalities: [MODALITY.TEXT],
            capabilities: []
          }
        }))
      )
    const oldModels = [
      ...new Set(
        (channel.sessions || []).map((item) => item.Model).filter((id) => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(id))
      )
    ].filter((id) => !modelService.list({ providerId }).some((item) => item.apiModelId === id))
    if (oldModels.length)
      modelService.create(
        oldModels.map((id) => ({
          dto: {
            providerId,
            modelId: id,
            name: id,
            endpointTypes: [endpoint],
            supportsStreaming: true,
            inputModalities: [MODALITY.TEXT],
            outputModalities: [MODALITY.TEXT],
            capabilities: []
          }
        }))
      )
    for (const model of modelService.list({ providerId }))
      modelService.update(providerId, model.apiModelId!, {
        isEnabled: channel.models.some((item) => item.id === model.apiModelId)
      })
    const selected = modelService.list({ providerId }).find((item) => item.apiModelId === channel.model)!
    application.get('DbService').withWriteTx((db) => {
      const key =
        'managed_chat.legacy.' +
        createHash('sha256')
          .update(channel.platform + '\n' + channel.key)
          .digest('hex')
      if (db.select().from(appStateTable).where(eq(appStateTable.key, key)).get()) return
      const first = assistantDataService
        .list({ page: 1, limit: 100 })
        .items.find((item) => item.name.includes('Cherry') || item.name === getManagedChatName())
      const assistant = first
        ? assistantDataService.update(first.id, { name: getManagedChatName(), modelId: selected.id, prompt: '' })
        : assistantDataService.create({ name: getManagedChatName(), modelId: selected.id, prompt: '' })
      for (const old of channel.sessions || []) {
        const model = modelService.list({ providerId }).find((item) => item.apiModelId === old.Model)
        const topic = topicService.create({
          name: old.Title,
          assistantId: this.modelContext(model?.id || selected.id, true)
        })
        for (const turn of old.Turns) {
          messageService.create(topic.id, {
            role: 'user',
            data: { parts: [{ type: 'text', text: turn.User }] },
            status: 'success'
          })
          if (turn.Assistant)
            messageService.create(topic.id, {
              role: 'assistant',
              data: { parts: [{ type: 'text', text: turn.Assistant }] },
              modelId: model?.id,
              status: turn.State === 'complete' ? 'success' : 'paused'
            })
        }
      }
      db.insert(appStateTable)
        .values({
          key,
          value: { imported: (channel.sessions || []).map((item) => item.Id), assistantId: assistant.id }
        })
        .run()
    })
  }
  async connectKey(key: string, remember: boolean): Promise<{ platform: ManagedChatPlatform }> {
    const config = getManagedChatConfig()!
    if (!key.trim() || /[\r\n]/.test(key) || key.length > 4096) throw new Error('Invalid personal Key')
    let accepted: ManagedChatChannel | null = null
    for (const platform of ['claude', 'gemini'] as const) {
      const candidate: ManagedChatChannel = {
        platform,
        key: key.trim(),
        models: [],
        model: '',
        channel: '',
        sessions: []
      }
      try {
        await this.readModels(candidate)
        accepted = candidate
        break
      } catch (error) {
        if (!/HTTP (401|403)/.test(String(error))) throw error
      }
    }
    if (!accepted) throw new Error('Key is invalid or belongs to another platform')
    await new Promise<void>((resolve, reject) => {
      const child = execFile(
        process.env.API_CHAT_LAUNCHER!,
        ['--chat-save-key'],
        { windowsHide: true, maxBuffer: 16384 },
        (error) => (error ? reject(error) : resolve())
      )
      child.stdin!.end(
        JSON.stringify({
          server: config.server,
          profile: process.env.API_CHAT_PROFILE,
          group: config.group,
          platform: accepted!.platform,
          key: accepted!.key,
          remember
        })
      )
    })
    config.channels = config.channels.filter((item) => item.platform !== accepted!.platform).concat(accepted)
    this.configureChannel(accepted)
    notifyDataApiDataChange([
      { endpoint: '/providers', kind: 'membership' },
      { endpoint: '/models', kind: 'membership' },
      { endpoint: '/models', kind: 'projection' }
    ])
    return { platform: accepted.platform }
  }
  async getInfo(): Promise<OutputFor<'managed_chat.info'>> {
    const config = getManagedChatConfig()
    if (!config) return { enabled: false, name: '', icon: '', platforms: [] }
    const icon = await fs.readFile(application.getPath('feature.managed_chat.brand_icon_file'))
    return {
      enabled: true,
      name: getManagedChatName(),
      icon: 'data:image/png;base64,' + icon.toString('base64'),
      platforms: config.channels.map((item) => item.platform)
    }
  }
  async connectKeys(input: {
    gemini: string
    claude: string
    remember: boolean
  }): Promise<OutputFor<'managed_chat.connect_keys'>> {
    if (this.connectingKeys) throw new Error('Key 更新正在进行，请稍后再试。')
    const config = getManagedChatConfig()!
    const provided = (['gemini', 'claude'] as const).filter((platform) => input[platform].trim())
    if (!provided.length) throw new Error('请至少填写 Gemini 或 Claude 的一个 Key。')
    if (provided.some((platform) => /[\x00-\x1f\x7f]/.test(input[platform]) || input[platform].length > 4096))
      throw new Error('Key 格式无效，不能包含换行或控制字符。')
    const replacement = provided.some((platform) =>
      config.channels.some((channel) => channel.platform === platform && channel.key !== input[platform].trim())
    )
    if (replacement && messageService.findPendingAssistantMessageIds().length)
      throw new Error('正在生成回复，请先等待完成或停止回复，再更换 Key；当前会话仍保留。')
    this.connectingKeys = true
    try {
      const accepted: ManagedChatChannel[] = []
      for (const platform of provided) {
        const candidate: ManagedChatChannel = {
          platform,
          key: input[platform].trim(),
          models: [],
          model: config.channels.find((channel) => channel.platform === platform)?.model || '',
          channel: '',
          sessions: []
        }
        try {
          await this.readModels(candidate)
        } catch (error) {
          throw new Error(
            (platform === 'claude' ? 'Claude' : 'Gemini') +
              ' Key 未接通：' +
              (error instanceof Error ? error.message : '模型目录暂不可用')
          )
        }
        accepted.push(candidate)
      }
      if (process.platform !== 'win32' && process.platform !== 'darwin') {
        for (const channel of accepted) await this.connectKey(channel.key, input.remember)
        return { platforms: accepted.map((channel) => channel.platform), switched: false }
      }
      const channels = config.channels.filter((channel) => !provided.includes(channel.platform)).concat(accepted)
      const keys = Object.fromEntries(channels.map((channel) => [channel.platform, channel.key]))
      if (replacement && messageService.findPendingAssistantMessageIds().length)
        throw new Error('正在生成回复，请先停止或等待完成，再更换 Key。')
      const result = await new Promise<{ saved: boolean; switched: boolean }>((resolve, reject) => {
        const child = execFile(
          process.env.API_CHAT_LAUNCHER!,
          ['--chat-save-keys'],
          { windowsHide: true, maxBuffer: 16384, timeout: 120000, encoding: 'utf8' },
          (error, stdout, stderr) => {
            if (error) {
              reject(new Error(stderr.trim() || 'Key 保存或独立会话启动未完成，请从主界面重试。'))
              return
            }
            try {
              resolve(JSON.parse(stdout))
            } catch {
              reject(new Error('Key 保存结果无效，未报告成功。'))
            }
          }
        )
        child.stdin!.end(
          JSON.stringify({
            server: config.server,
            profile: process.env.API_CHAT_PROFILE,
            group: config.group,
            entryPlatform: accepted[0].platform,
            enteredPlatforms: provided,
            claude: keys.claude || '',
            gemini: keys.gemini || '',
            remember: input.remember,
            replacement
          })
        )
      })
      if (!result.saved) throw new Error('Key 尚未保存，原配置仍可用。')
      if (result.switched) {
        setTimeout(() => {
          if (messageService.findPendingAssistantMessageIds().length === 0) app.quit()
        }, 300)
      } else {
        config.channels = channels
        for (const channel of accepted) this.configureChannel(channel)
        notifyDataApiDataChange([
          { endpoint: '/providers', kind: 'membership' },
          { endpoint: '/models', kind: 'membership' },
          { endpoint: '/models', kind: 'projection' }
        ])
      }
      return { platforms: accepted.map((channel) => channel.platform), switched: result.switched }
    } finally {
      this.connectingKeys = false
    }
  }
  private modelContext(modelId: string, archived = false): string {
    const config = getManagedChatConfig()!
    const model = config.channels
      .flatMap((channel) =>
        modelService
          .list({ providerId: 'api-' + channel.platform })
          .filter((item) => archived || channel.models.some((allowed) => allowed.id === item.apiModelId))
      )
      .find((item) => item.id === modelId)
    if (!model) throw new Error('Model is not authorized by an active platform Key')
    return application.get('DbService').withWriteTx((db) => {
      const key = 'managed_chat.model.' + modelId
      const old = db.select().from(appStateTable).where(eq(appStateTable.key, key)).get()
      if (old) {
        const value = old.value as { assistantId: string }
        return value.assistantId
      }
      const owner = assistantDataService.create({
        name: model.name,
        modelId: model.id,
        prompt: '',
        settings: { ...DEFAULT_ASSISTANT_SETTINGS, enableBrowser: false }
      })
      db.insert(appStateTable)
        .values({ key, value: { assistantId: owner.id } })
        .run()
      return owner.id
    })
  }
  getWorkspace(): OutputFor<'managed_chat.workspace'> {
    const config = getManagedChatConfig()!
    const models = config.channels.flatMap((channel) =>
      modelService
        .list({ providerId: 'api-' + channel.platform })
        .filter(
          (item) =>
            channel.models.some((allowed) => allowed.id === item.apiModelId) ||
            application
              .get('DbService')
              .getDb()
              .select()
              .from(appStateTable)
              .where(eq(appStateTable.key, 'managed_chat.model.' + item.id))
              .get()
        )
        .map((model) => {
          const assistantId = this.modelContext(model.id, true)
          const topics = topicService
            .listActiveIdsByAssistant(assistantId)
            .map((id) => topicService.getById(id))
            .map((topic) => ({
              id: topic.id,
              name: topic.name,
              lastActivityAt: topic.lastActivityAt,
              latestReplyAt: 0
            }))
          return {
            id: model.id,
            name: model.name,
            platform: channel.platform,
            available: channel.models.some((allowed) => allowed.id === model.apiModelId),
            topics
          }
        })
    )
    const ids = models.flatMap((model) => model.topics.map((topic) => topic.id))
    if (ids.length) {
      const metadata = application
        .get('DbService')
        .getDb()
        .select({
          id: topicTable.id,
          // Keep the outer topic qualifier; Drizzle strips interpolated column qualifiers in a single-table projection.
          firstUserText: sql<string>`coalesce((select substr(m.searchable_text, 1, 120) from message m where m.topic_id = topic.id and m.role = 'user' and m.deleted_at is null order by m.created_at, m.id limit 1), '')`,
          latestReplyAt: sql<number>`coalesce((select max(m.created_at) from message m where m.topic_id = topic.id and m.role = 'assistant' and m.status = 'success' and m.deleted_at is null), 0)`
        })
        .from(topicTable)
        .where(inArray(topicTable.id, ids))
        .all()
      const byId = new Map(metadata.map((row) => [row.id, row]))
      for (const model of models)
        for (const topic of model.topics) {
          const row = byId.get(topic.id)
          topic.latestReplyAt = row?.latestReplyAt || 0
          if (!topic.name)
            topic.name = Array.from((row?.firstUserText || '').replace(/\s+/g, ' ').trim())
              .slice(0, 56)
              .join('')
        }
    }
    return { models }
  }
  createTopic(modelId: string): { id: string } {
    const assistantId = this.modelContext(modelId)
    const topic = topicService.create({ assistantId, name: '' })
    return { id: topic.id }
  }
  async getQuota(): Promise<OutputFor<'managed_chat.quota'>> {
    const config = getManagedChatConfig()!
    const accounts: OutputFor<'managed_chat.quota'>['accounts'] = []
    for (const channel of config.channels) {
      if (channel.catalogError) {
        accounts.push({ platform: channel.platform, quota: null, stale: true })
        continue
      }
      try {
        const response = await this.fetchGateway('/' + channel.platform + '/v1/cockpit/quota', {
          headers: { [channel.platform === 'claude' ? 'x-api-key' : 'x-goog-api-key']: channel.key },
          signal: AbortSignal.timeout(15000)
        })
        if (!response.ok) throw new Error('Quota HTTP ' + response.status)
        const data = await response.json()
        accounts.push(
          ...(Array.isArray(data.accounts) ? data.accounts : []).map((row: object) => ({
            ...row,
            platform: channel.platform
          }))
        )
      } catch {
        accounts.push({ platform: channel.platform, quota: null, stale: true })
      }
    }
    return { accounts }
  }
  protected async onReady(): Promise<void> {
    if (!getManagedChatConfig()) return
    this.registerDisposable(
      application.get('WindowManager').onWindowCreatedByType(WindowType.Main, () => {
        this.presented = false
      })
    )
    let polling = false
    const activity = async () => {
      if (polling) return
      polling = true
      try {
        const activeReplies = messageService.findPendingAssistantMessageIds().length
        const file = application.getPath('feature.managed_chat.activity_file')
        const temporary = file + '.tmp'
        await fs.writeFile(temporary, JSON.stringify({ pid: process.pid, activeReplies }))
        await fs.rename(temporary, file)
        const requestFile = application.getPath('feature.managed_chat.update_request_file')
        const request = await fs.readFile(requestFile, 'utf8').then(
          (value) => JSON.parse(value),
          () => null
        )
        if (request?.pid === process.pid && /^[a-f0-9]{32}$/.test(request.nonce || '')) {
          await fs.unlink(requestFile)
          if (activeReplies === 0) app.quit()
        }
      } catch (error) {
        loggerService.withContext('ManagedChat').warn('Update activity state unavailable', { error })
      } finally {
        polling = false
      }
    }
    const timer = setInterval(() => void activity(), 1000)
    this.registerDisposable(() => clearInterval(timer))
    await activity()
  }
  async rendererReady(): Promise<void> {
    if (!getManagedChatConfig() || this.presented) return
    this.presented = true
    application.get('MainWindowService').showMainWindow()
    await fs.writeFile(
      application.getPath('feature.managed_chat.ready_file'),
      JSON.stringify({ pid: process.pid, platform: 'shared' })
    )
  }
}
