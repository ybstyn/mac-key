import { ChevronDown, ChevronRight, Info, MessageSquare, Plus, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  Button,
  Input,
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  Popover,
  PopoverTrigger,
  PopoverContent
} from '@cherrystudio/ui'
import { cacheService } from '@data/CacheService'
import { dataApiService } from '@data/DataApiService'
import { useQuery } from '@data/hooks/useDataApi'
import { ManagedQuota } from '@renderer/components/chat/ManagedQuota'
import PromptPopup from '@renderer/components/popups/PromptPopup'
import { useAssistant } from '@renderer/hooks/useAssistant'
import { mapApiTopicToRendererTopic } from '@renderer/hooks/useTopic'
import { ipcApi } from '@renderer/ipc'
import Chat from '@renderer/pages/home/Chat'
import { TopicRightPane } from '@renderer/pages/home/components/TopicRightPane'
import { exportTopicAsMarkdown } from '@renderer/services/ExportService'
import type { OutputFor } from '@shared/ipc/types'

type ModelRow = OutputFor<'managed_chat.workspace'>['models'][number]

function modelGuidance(model: ModelRow) {
  const id = model.id.toLowerCase()
  if (model.platform === 'claude') {
    const quota =
      '使用 Claude 订阅账号时，模型共用账号的 5 小时和周额度。没有固定调用次数；消息、历史长度及思考强度都会影响消耗。绑定同一账号的分发 Key 也共用额度。'
    if (id.includes('claude-fable-'))
      return {
        summary: 'Pro 需额外积分',
        purpose: '选择前先确认账号的 Fable 使用权限与积分状态。',
        quota:
          'Pro 订阅不包含 Fable 用量，需要开启额外用量并配置积分。Max 等套餐以账号权限和实际配额为准。输入分发 Key 不会增加账号额度。',
        notice: true
      }
    if (id.includes('claude-haiku-'))
      return {
        summary: '轻快 · 共享额度',
        purpose: '适合简短问答、摘要和轻量任务，一般开销较低。',
        quota,
        notice: false
      }
    if (id.includes('claude-sonnet-'))
      return {
        summary: '均衡 · 共享额度',
        purpose: '适合日常写作、编程和分析，兼顾速度与复杂任务。',
        quota,
        notice: false
      }
    if (id.includes('claude-opus-'))
      return {
        summary: '深入 · 共享额度',
        purpose: '适合复杂推理与深入分析，通常比 Sonnet、Haiku 消耗更多额度。',
        quota,
        notice: false
      }
    return { summary: '依账号计额 · 次数不固定', purpose: '能力以账号返回的模型目录为准。', quota, notice: false }
  }
  const quota =
    '配额以账号及侧栏显示为准，没有固定消息次数。网页账号通道使用共享计算额度，不能把计算额度或 Token 换算成固定对话次数。'
  if (id.includes('thinking'))
    return {
      summary: '推理优先 · 账号配额',
      purpose: '适合需要多步思考的文本问题，等待时间和消耗可能增加。',
      quota,
      notice: false
    }
  if (id.includes('flash'))
    return { summary: '响应优先 · 账号配额', purpose: '适合日常问答、改写和快速文本处理。', quota, notice: false }
  if (id.includes('pro'))
    return { summary: '复杂任务 · 账号配额', purpose: '适合复杂文本分析、推理和编程问题。', quota, notice: false }
  return { summary: '依账号计额 · 次数不固定', purpose: '能力以账号返回的模型目录为准。', quota, notice: false }
}

export default function ManagedChatPage() {
  const { t } = useTranslation()
  const [models, setModels] = useState<ModelRow[]>([])
  const [selectedModel, setSelectedModel] = useState('')
  const [topicId, setTopicId] = useState<string | null>(() => cacheService.getPersist('ui.chat.last_used_topic_id'))
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState('')
  const [error, setError] = useState('')
  const [creating, setCreating] = useState(false)
  const initialized = useRef(false)
  const framePrepared = useRef(false)
  const topicQuery = useQuery('/topics/:id', { params: { id: topicId || '' }, enabled: Boolean(topicId) })
  const topic = topicQuery.data ? mapApiTopicToRendererTopic(topicQuery.data) : undefined
  const assistant = useAssistant(topic?.assistantId)
  const reload = useCallback(async () => {
    try {
      const result = await ipcApi.request('managed_chat.workspace')
      setModels(result.models)
      setError('')
      setSelectedModel((old) => (result.models.some((item) => item.id === old) ? old : result.models[0]?.id || ''))
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t('common.error'))
    }
  }, [t])
  useEffect(() => {
    void reload()
    const tick = setInterval(() => {
      if (!document.hidden) void reload()
    }, 2000)
    return () => clearInterval(tick)
  }, [reload])
  useEffect(() => {
    if (topicId) cacheService.setPersist('ui.chat.last_used_topic_id', topicId)
  }, [topicId])
  useEffect(() => {
    if (framePrepared.current || (!error && (!models.length || !topic || topicQuery.isLoading))) return
    framePrepared.current = true
    void document.fonts.ready
      .then(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
      .then(() => ipcApi.request('managed_chat.renderer_ready'))
  }, [models.length, topic, topicQuery.isLoading, error])
  useEffect(() => {
    if (assistant.assistant?.modelId) {
      setSelectedModel(assistant.assistant.modelId)
      setExpanded((old) => new Set([...old, assistant.assistant!.modelId!]))
    }
  }, [assistant.assistant?.modelId])
  const create = async (modelId = selectedModel) => {
    if (!modelId || creating) return
    setCreating(true)
    try {
      const result = await ipcApi.request('managed_chat.create_topic', { modelId })
      setSelectedModel(modelId)
      setExpanded((old) => new Set([...old, modelId]))
      setTopicId(result.id)
      await reload()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t('common.error'))
    } finally {
      setCreating(false)
    }
  }
  const chooseModel = async (model: ModelRow) => {
    setSelectedModel(model.id)
    setExpanded((old) => new Set([...old, model.id]))
    if (model.topics.length) {
      if (!model.topics.some((item) => item.id === topicId)) setTopicId(model.topics[0].id)
    } else await create(model.id)
  }
  useEffect(() => {
    if (initialized.current || !models.length) return
    initialized.current = true
    const restored = models.find((model) => model.topics.some((item) => item.id === topicId))
    const first = restored || models.find((model) => model.topics.length) || models[0]
    setSelectedModel(first.id)
    setExpanded(new Set([first.id]))
    if (!restored) {
      if (first.topics.length) setTopicId(first.topics[0].id)
      else void create(first.id)
    }
  }, [models, topicId])
  const remove = async (id: string) => {
    try {
      await dataApiService.delete(('/topics/' + id) as `/topics/${string}`)
      if (topicId === id) setTopicId(null)
      await reload()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t('common.error'))
    }
  }
  const rename = async (id: string, name: string) => {
    const value = await PromptPopup.show({ title: t('chat.topics.edit.title'), message: '', defaultValue: name })
    if (!value?.trim()) return
    try {
      await dataApiService.patch(('/topics/' + id) as `/topics/${string}`, {
        body: { name: value.trim(), isNameManuallyEdited: true }
      })
      await reload()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t('common.error'))
    }
  }
  const exportConversation = async (id: string) => {
    try {
      const row = await dataApiService.get(('/topics/' + id) as `/topics/${string}`)
      await exportTopicAsMarkdown(mapApiTopicToRendererTopic(row))
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t('common.error'))
    }
  }
  return (
    <div data-ui="api-managed.workspace" className="flex h-full min-h-0 min-w-0 flex-1 bg-background">
      <aside className="flex w-[252px] min-w-[230px] shrink-0 flex-col gap-2 bg-sidebar p-3">
        <Button
          data-ui="api-managed.new-topic"
          variant="outline"
          disabled={!models.find((model) => model.id === selectedModel)?.available || creating}
          onClick={() => void create()}>
          <Plus className="size-4" />
          {t('api_managed.new_topic')}
        </Button>
        <Input
          aria-label={t('api_managed.search')}
          placeholder={t('api_managed.search')}
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
        <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {(['gemini', 'claude'] as const).map((platform) => (
            <section key={platform} className="mb-3">
              <h2 className="px-2 py-2 text-xs font-medium text-muted-foreground">
                {platform === 'claude' ? 'Claude' : 'Gemini'}
              </h2>
              {models
                .filter((model) => model.platform === platform)
                .map((model) => {
                  const guidance = modelGuidance(model)
                  return (
                    <div key={model.id}>
                      <div className="flex min-w-0 items-center">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-7 shrink-0"
                          aria-label={expanded.has(model.id) ? t('common.collapse') : t('common.expand')}
                          onClick={() =>
                            setExpanded((old) => {
                              const next = new Set(old)
                              if (next.has(model.id)) next.delete(model.id)
                              else next.add(model.id)
                              return next
                            })
                          }>
                          {expanded.has(model.id) ? (
                            <ChevronDown className="size-3" />
                          ) : (
                            <ChevronRight className="size-3" />
                          )}
                        </Button>
                        <Button
                          data-ui="api-managed.model"
                          data-model-id={model.id}
                          variant="ghost"
                          className="h-auto min-h-11 min-w-0 flex-1 items-start justify-start gap-2 whitespace-normal px-2 py-2 text-left"
                          onClick={() => void chooseModel(model)}>
                          <span className="flex min-w-0 flex-col gap-1">
                            <span className="break-words text-[13px] leading-normal">{model.name}</span>
                            <span
                              data-ui="api-managed.guide-summary"
                              className={
                                'break-words text-[11px] leading-4 ' +
                                (guidance.notice ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground')
                              }>
                              {guidance.summary}
                            </span>
                          </span>
                        </Button>
                        <Popover>
                          <PopoverTrigger asChild>
                            <Button
                              data-ui="api-managed.guide-trigger"
                              data-guide-model={model.id}
                              variant="ghost"
                              size="icon"
                              className="size-7 shrink-0 text-muted-foreground"
                              aria-label={model.name + ' 模型说明与额度'}>
                              <Info className="size-3.5" />
                            </Button>
                          </PopoverTrigger>
                          <PopoverContent
                            side="right"
                            align="start"
                            collisionPadding={12}
                            className="w-80 max-w-[calc(100vw-32px)] rounded-xl p-4"
                            aria-label={model.name + ' 模型说明与额度'}>
                            <div data-ui="api-managed.guide-detail" className="space-y-3 text-left">
                              <p className="break-words text-sm font-semibold leading-5">{model.name}</p>
                              <p className="text-xs leading-5 text-foreground">{guidance.purpose}</p>
                              <p
                                className={
                                  'text-xs leading-5 ' +
                                  (guidance.notice ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground')
                                }>
                                {guidance.quota}
                              </p>
                              <p className="text-[11px] leading-4 text-muted-foreground">
                                实时剩余额度和重置时间见左侧“模型配额”。
                              </p>
                            </div>
                          </PopoverContent>
                        </Popover>
                      </div>
                      {expanded.has(model.id) && (
                        <div className="ml-3 space-y-1 border-l border-border-subtle pl-2">
                          {model.topics
                            .filter((item) => !filter || item.name.toLowerCase().includes(filter.toLowerCase()))
                            .map((item) => (
                              <ContextMenu key={item.id}>
                                <ContextMenuTrigger asChild>
                                  <div className="group flex min-w-0 items-center rounded-md hover:bg-accent">
                                    <Button
                                      data-ui="api-managed.topic"
                                      data-topic-id={item.id}
                                      variant="ghost"
                                      className={
                                        'min-w-0 flex-1 justify-start gap-2 px-2 text-left ' +
                                        (item.id === topicId ? 'bg-accent' : '')
                                      }
                                      onClick={() => setTopicId(item.id)}>
                                      <MessageSquare className="size-3 shrink-0" />
                                      <span className="truncate text-xs" title={item.name}>
                                        {item.name || t('api_managed.new_topic')}
                                      </span>
                                    </Button>
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="size-7 shrink-0 opacity-0 group-hover:opacity-100 focus:opacity-100"
                                      aria-label={t('api_managed.delete_topic')}
                                      onClick={() => void remove(item.id)}>
                                      <Trash2 className="size-3" />
                                    </Button>
                                  </div>
                                </ContextMenuTrigger>
                                <ContextMenuContent>
                                  <ContextMenuItem onSelect={() => void rename(item.id, item.name)}>
                                    {t('chat.topics.edit.title')}
                                  </ContextMenuItem>
                                  <ContextMenuItem onSelect={() => void exportConversation(item.id)}>
                                    {t('chat.topics.export.markdown')}
                                  </ContextMenuItem>
                                  <ContextMenuItem onSelect={() => void remove(item.id)}>
                                    {t('api_managed.delete_topic')}
                                  </ContextMenuItem>
                                </ContextMenuContent>
                              </ContextMenu>
                            ))}
                          {model.available && (
                            <Button
                              variant="ghost"
                              className="h-7 w-full justify-start gap-2 px-2 text-xs text-muted-foreground"
                              onClick={() => void create(model.id)}>
                              <Plus className="size-3" />
                              {t('api_managed.new_topic')}
                            </Button>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
            </section>
          ))}
        </div>
        <ManagedQuota />
      </aside>
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        {selectedModel && !models.find((model) => model.id === selectedModel)?.available && (
          <p role="status" className="px-4 py-2 text-xs text-muted-foreground">
            {t('code.model_required')}
          </p>
        )}
        {error && (
          <p role="alert" className="px-4 py-2 text-xs text-error">
            {error}
          </p>
        )}
        <TopicRightPane.Scope topicId={topic?.id} topicName={topic?.name} traceId={topic?.traceId}>
          <Chat
            activeTopic={topic}
            readOnly={!models.find((model) => model.id === selectedModel)?.available}
            topicPending={topicQuery.isLoading}
            onNewTopic={() => create()}
            onCreateEmptyTopic={() => create()}
            showResourceListControls={false}
          />
        </TopicRightPane.Scope>
      </main>
    </div>
  )
}
