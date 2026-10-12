import { ChevronDown, Check, Info, LoaderCircle, MessageSquare, MoreHorizontal, Plus } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  Button,
  Input,
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  Popover,
  PopoverTrigger,
  PopoverContent
} from '@cherrystudio/ui'
import { ManagedQuota } from '@renderer/components/chat/ManagedQuota'
import { useTopicStreamStatus } from '@renderer/hooks/useTopicStreamStatus'
import type { OutputFor } from '@shared/ipc/types'

type ModelRow = OutputFor<'managed_chat.workspace'>['models'][number]
type TopicRow = ModelRow['topics'][number]

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

function ModelGuide({ model, current = false }: { model: ModelRow; current?: boolean }) {
  const { t } = useTranslation()
  const guidance = modelGuidance(model)
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          data-ui={current ? 'api-managed.current-guide' : 'api-managed.guide-trigger'}
          data-guide-model={current ? undefined : model.id}
          variant="ghost"
          size="icon"
          className="size-7 shrink-0 text-muted-foreground"
          aria-label={t('api_managed.guide_label', { model: model.name })}>
          <Info className="size-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="right"
        align="start"
        collisionPadding={12}
        className="w-80 max-w-[calc(100vw-32px)] rounded-xl p-4">
        <div data-ui="api-managed.guide-detail" className="space-y-3 text-left">
          <p className="break-words text-sm font-semibold leading-5">{model.name}</p>
          <p className="text-xs leading-5">{guidance.purpose}</p>
          <p className={'text-xs leading-5 ' + (guidance.notice ? 'text-warning' : 'text-muted-foreground')}>
            {guidance.quota}
          </p>
          <p className="text-[11px] leading-4 text-muted-foreground">{t('api_managed.guide_footer')}</p>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function ReplyIndicator({ topicId, unread }: { topicId: string; unread: boolean }) {
  const { t } = useTranslation()
  const { isPending } = useTopicStreamStatus(topicId)
  if (unread)
    return (
      <span
        data-ui="api-managed.unread"
        data-unread-topic={topicId}
        aria-label={t('api_managed.unread')}
        title={t('api_managed.unread')}
        className="size-1.5 shrink-0 rounded-full bg-info"
      />
    )
  if (isPending)
    return (
      <LoaderCircle
        className="size-3 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none"
        aria-label={t('common.loading')}
      />
    )
  return null
}

function TopicActions({
  context,
  topic,
  onRename,
  onExport,
  onDelete
}: {
  context: boolean
  topic: TopicRow
  onRename: (id: string, name: string) => void
  onExport: (id: string) => void
  onDelete: (topic: TopicRow) => void
}) {
  const { t } = useTranslation()
  const Item = context ? ContextMenuItem : DropdownMenuItem
  return (
    <>
      <Item onSelect={() => onRename(topic.id, topic.name)}>{t('chat.topics.edit.title')}</Item>
      <Item onSelect={() => onExport(topic.id)}>{t('chat.topics.export.markdown')}</Item>
      <Item data-ui="api-managed.delete-topic" className="text-destructive" onSelect={() => onDelete(topic)}>
        {t('api_managed.delete_topic')}
      </Item>
    </>
  )
}

export function ManagedChatSidebar({
  models,
  selectedModel,
  topicId,
  unread,
  onModel,
  onTopic,
  onCreate,
  creating,
  onRename,
  onExport,
  onDelete
}: {
  models: ModelRow[]
  selectedModel: string
  topicId: string | null
  unread: Set<string>
  onModel: (model: ModelRow) => void
  onTopic: (id: string) => void
  onCreate: () => void
  creating: boolean
  onRename: (id: string, name: string) => void
  onExport: (id: string) => void
  onDelete: (topic: TopicRow) => void
}) {
  const { t } = useTranslation()
  const [pickerOpen, setPickerOpen] = useState(false)
  const [modelFilter, setModelFilter] = useState('')
  const [filter, setFilter] = useState('')
  const [lastModels, setLastModels] = useState<Record<string, string>>({})
  const active = models.find((model) => model.id === selectedModel)
  const platform = active?.platform || 'gemini'
  const pick = (model: ModelRow) => {
    setLastModels((old) => ({ ...old, [model.platform]: model.id }))
    setPickerOpen(false)
    setFilter('')
    onModel(model)
  }
  const search = filter.trim().toLowerCase()
  const topics = (search ? models : active ? [active] : [])
    .flatMap((model) => model.topics.map((item) => ({ ...item, model })))
    .filter((item) => !search || (item.name + ' ' + item.model.name).toLowerCase().includes(search))
    .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
  const date = new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
  return (
    <aside
      data-ui="api-managed.sidebar"
      className="flex w-[272px] min-w-[252px] shrink-0 flex-col gap-3 bg-sidebar px-3 pt-4 pb-2">
      <div className="flex shrink-0 gap-1 rounded-xl bg-background-subtle p-1" aria-label={t('api_managed.platform')}>
        {(['gemini', 'claude'] as const).map((value) => {
          const group = models.filter((model) => model.platform === value)
          const hasUnread = group.some((model) => model.topics.some((topic) => unread.has(topic.id)))
          return (
            <Button
              key={value}
              data-ui="api-managed.platform"
              data-platform={value}
              aria-pressed={platform === value}
              variant="ghost"
              className={
                'h-9 min-w-0 flex-1 gap-2 rounded-lg text-sm ' +
                (platform === value ? 'bg-card font-medium shadow-sm' : 'text-muted-foreground')
              }
              disabled={!group.length}
              onClick={() => {
                if (platform === value) return
                pick(
                  group.find((model) => model.id === lastModels[value]) ||
                    group.find((model) => model.topics.some((topic) => unread.has(topic.id))) ||
                    group[0]
                )
              }}>
              {value === 'claude' ? 'Claude' : 'Gemini'}
              {hasUnread && (
                <span
                  data-ui="api-managed.platform-unread"
                  className="size-1.5 shrink-0 rounded-full bg-info"
                  aria-label={t('api_managed.unread')}
                />
              )}
            </Button>
          )
        })}
      </div>
      <div className="shrink-0 space-y-2">
        <p className="px-1 text-xs text-muted-foreground">{t('api_managed.choose_model')}</p>
        <div className="flex min-w-0 items-center gap-1">
          <Popover
            open={pickerOpen}
            onOpenChange={(open) => {
              setPickerOpen(open)
              if (open) setModelFilter('')
            }}>
            <PopoverTrigger asChild>
              <Button
                data-ui="api-managed.model-picker"
                variant="outline"
                className="h-auto min-h-14 min-w-0 flex-1 justify-between gap-2 rounded-xl bg-card px-3 py-2 text-left">
                <span className="flex min-w-0 flex-col gap-1">
                  <span className="break-words whitespace-normal text-[13px] font-medium leading-5">
                    {active?.name || t('api_managed.choose_model')}
                  </span>
                  {active && (
                    <span
                      className={
                        'text-[11px] font-normal leading-4 ' +
                        (modelGuidance(active).notice ? 'text-warning' : 'text-muted-foreground')
                      }>
                      {modelGuidance(active).summary}
                    </span>
                  )}
                </span>
                <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
              </Button>
            </PopoverTrigger>
            <PopoverContent
              side="right"
              align="start"
              collisionPadding={12}
              className="w-[360px] max-w-[calc(100vw-32px)] rounded-xl p-2">
              <div className="mb-2 flex items-center justify-between px-2 py-1">
                <p className="text-sm font-medium">{t('api_managed.choose_model')}</p>
                <span className="text-xs text-muted-foreground">
                  {t('api_managed.model_count', { count: models.length })}
                </span>
              </div>
              <Input
                data-ui="api-managed.model-search"
                aria-label={t('api_managed.search_models')}
                placeholder={t('api_managed.search_models')}
                value={modelFilter}
                onChange={(event) => setModelFilter(event.target.value)}
              />
              <div
                data-ui="api-managed.model-catalog"
                className="mt-2 max-h-[min(55vh,480px)] overflow-y-auto [scrollbar-width:thin]">
                {(['gemini', 'claude'] as const).map((value) => (
                  <section key={value} className="mb-2">
                    <p className="sticky top-0 bg-popover px-2 py-2 text-xs font-medium text-muted-foreground">
                      {value === 'claude' ? 'Claude' : 'Gemini'}
                    </p>
                    {models
                      .filter(
                        (model) =>
                          model.platform === value &&
                          (!modelFilter ||
                            (model.name + ' ' + model.id).toLowerCase().includes(modelFilter.toLowerCase()))
                      )
                      .map((model) => {
                        const guidance = modelGuidance(model)
                        return (
                          <div key={model.id} className="flex min-w-0 items-center gap-1 rounded-lg hover:bg-accent">
                            <Button
                              data-ui="api-managed.model"
                              data-model-id={model.id}
                              variant="ghost"
                              className={
                                'h-auto min-h-12 min-w-0 flex-1 justify-start gap-2 px-2 py-2 text-left ' +
                                (model.id === selectedModel ? 'bg-accent' : '')
                              }
                              onClick={() => pick(model)}>
                              <span className="flex min-w-0 flex-1 flex-col gap-1">
                                <span className="break-words whitespace-normal text-[13px] leading-5">
                                  {model.name}
                                </span>
                                <span
                                  data-ui="api-managed.guide-summary"
                                  className={
                                    'text-[11px] font-normal leading-4 ' +
                                    (guidance.notice ? 'text-warning' : 'text-muted-foreground')
                                  }>
                                  {guidance.summary}
                                </span>
                              </span>
                              {model.topics.some((topic) => unread.has(topic.id)) && (
                                <span
                                  data-ui="api-managed.model-unread"
                                  className="size-1.5 shrink-0 rounded-full bg-info"
                                  aria-label={t('api_managed.unread')}
                                />
                              )}
                              {model.id === selectedModel && (
                                <Check className="size-3.5 shrink-0 text-muted-foreground" />
                              )}
                            </Button>
                            <ModelGuide model={model} />
                          </div>
                        )
                      })}
                  </section>
                ))}
              </div>
            </PopoverContent>
          </Popover>
          {active && <ModelGuide model={active} current />}
        </div>
      </div>
      <Button
        data-ui="api-managed.new-topic"
        variant="outline"
        className="h-9 shrink-0 gap-2 rounded-lg"
        disabled={!active?.available || creating}
        onClick={onCreate}>
        <Plus className="size-4" />
        {t('api_managed.new_topic')}
      </Button>
      <Input
        data-ui="api-managed.topic-search"
        aria-label={t('api_managed.search')}
        placeholder={t('api_managed.search')}
        className="shrink-0"
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
      />
      <div className="flex shrink-0 items-center justify-between px-1 text-xs text-muted-foreground">
        <span>{t('api_managed.conversations')}</span>
        <span>{topics.length}</span>
      </div>
      <div data-ui="api-managed.topic-list" className="min-h-0 flex-1 overflow-y-auto [scrollbar-width:thin]">
        {!topics.length && (
          <p className="px-2 py-6 text-center text-xs leading-5 text-muted-foreground">
            {search ? t('common.no_results') : t('api_managed.empty_topics')}
          </p>
        )}
        {topics.map((item) => (
          <ContextMenu key={item.id}>
            <ContextMenuTrigger asChild>
              <div className="group mb-1 flex min-w-0 items-center gap-1 rounded-xl hover:bg-accent">
                <Button
                  data-ui="api-managed.topic"
                  data-topic-id={item.id}
                  data-topic-model={item.model.id}
                  aria-current={item.id === topicId ? 'page' : undefined}
                  variant="ghost"
                  className={
                    'h-auto min-h-14 min-w-0 flex-1 items-start justify-start gap-2 rounded-xl px-2 py-2 text-left ' +
                    (item.id === topicId ? 'bg-accent' : '')
                  }
                  onClick={() => {
                    if (selectedModel !== item.model.id) onModel(item.model)
                    onTopic(item.id)
                  }}>
                  <MessageSquare className="mt-1 size-3.5 shrink-0 text-muted-foreground" />
                  <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="flex min-w-0 items-center gap-2">
                      <span
                        className="line-clamp-2 flex-1 break-words whitespace-normal text-[13px] leading-5"
                        title={item.name}>
                        {item.name || t('api_managed.new_topic')}
                      </span>
                      <ReplyIndicator topicId={item.id} unread={unread.has(item.id)} />
                    </span>
                    <span className="truncate text-[11px] font-normal leading-4 text-muted-foreground">
                      {search
                        ? (item.model.platform === 'claude' ? 'Claude' : 'Gemini') + ' · ' + item.model.name
                        : date.format(new Date(item.lastActivityAt))}
                    </span>
                  </span>
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      data-ui="api-managed.topic-menu"
                      data-menu-topic={item.id}
                      variant="ghost"
                      size="icon"
                      className="size-7 shrink-0 text-muted-foreground opacity-50 group-hover:opacity-100 focus-visible:opacity-100"
                      aria-label={t('common.more')}
                      title={t('common.more')}>
                      <MoreHorizontal className="size-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent side="right" align="start">
                    <TopicActions
                      context={false}
                      topic={item}
                      onRename={onRename}
                      onExport={onExport}
                      onDelete={onDelete}
                    />
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <TopicActions context topic={item} onRename={onRename} onExport={onExport} onDelete={onDelete} />
            </ContextMenuContent>
          </ContextMenu>
        ))}
      </div>
      <ManagedQuota />
    </aside>
  )
}
