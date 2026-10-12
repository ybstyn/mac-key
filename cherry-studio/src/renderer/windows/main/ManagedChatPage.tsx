import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ConfirmDialog } from '@cherrystudio/ui'
import { cacheService } from '@data/CacheService'
import { dataApiService } from '@data/DataApiService'
import { usePersistCache } from '@data/hooks/useCache'
import { useQuery } from '@data/hooks/useDataApi'
import { ManagedChatSidebar } from '@renderer/components/chat/ManagedChatSidebar'
import PromptPopup from '@renderer/components/popups/PromptPopup'
import { useAssistant } from '@renderer/hooks/useAssistant'
import { mapApiTopicToRendererTopic } from '@renderer/hooks/useTopic'
import { ipcApi } from '@renderer/ipc'
import Chat from '@renderer/pages/home/Chat'
import { TopicRightPane } from '@renderer/pages/home/components/TopicRightPane'
import { exportTopicAsMarkdown } from '@renderer/services/ExportService'
import { classifyTurn } from '@shared/ai/transport'
import type { OutputFor } from '@shared/ipc/types'

type ModelRow = OutputFor<'managed_chat.workspace'>['models'][number]

export default function ManagedChatPage() {
  const { t } = useTranslation()
  const [models, setModels] = useState<ModelRow[]>([])
  const [selectedModel, setSelectedModel] = useState('')
  const [topicId, setTopicId] = useState<string | null>(() => cacheService.getPersist('ui.chat.last_used_topic_id'))
  const [readReceipts, setReadReceipts] = usePersistCache('ui.managed_chat.read_receipts')
  const [reading, setReading] = useState(() => !document.hidden && document.hasFocus())
  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string } | null>(null)
  const [removing, setRemoving] = useState(false)
  const deleting = useRef(false)
  const [error, setError] = useState('')
  const [workspaceError, setWorkspaceError] = useState('')
  const [creating, setCreating] = useState(false)
  const initialized = useRef(false)
  const framePrepared = useRef(false)
  const topicQuery = useQuery('/topics/:id', { params: { id: topicId || '' }, enabled: Boolean(topicId) })
  const projectedTitle = models.flatMap((model) => model.topics).find((item) => item.id === topicId)?.name
  const topic = topicQuery.data
    ? { ...mapApiTopicToRendererTopic(topicQuery.data), name: topicQuery.data.name || projectedTitle || '' }
    : undefined
  const assistant = useAssistant(topic?.assistantId)
  const reload = useCallback(async () => {
    try {
      const result = await ipcApi.request('managed_chat.workspace')
      setModels(result.models)
      setWorkspaceError('')
      setSelectedModel((old) => (result.models.some((item) => item.id === old) ? old : result.models[0]?.id || ''))
    } catch (failure) {
      setWorkspaceError(failure instanceof Error ? failure.message : t('common.error'))
    }
  }, [t])
  useEffect(() => {
    void reload()
    const tick = setInterval(() => {
      if (!document.hidden) void reload()
    }, 2000)
    const unsubscribe = dataApiService.onDataChanged(['/topics', '/topics/:topicId/messages'], () => {
      void reload()
    })
    const onVisibility = () => {
      if (!document.hidden) void reload()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      clearInterval(tick)
      unsubscribe()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [reload])
  useEffect(() => {
    cacheService.setPersist('ui.chat.last_used_topic_id', topicId)
  }, [topicId])
  useEffect(() => {
    if (framePrepared.current || (!workspaceError && (!models.length || !topic || topicQuery.isLoading))) return
    framePrepared.current = true
    void document.fonts.ready
      .then(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
      .then(() => ipcApi.request('managed_chat.renderer_ready'))
  }, [models.length, topic, topicQuery.isLoading, workspaceError])
  useEffect(() => {
    if (assistant.assistant?.modelId) {
      setSelectedModel(assistant.assistant.modelId)
    }
  }, [assistant.assistant?.modelId])
  const create = async (modelId = selectedModel) => {
    if (!modelId || creating) return
    setCreating(true)
    try {
      const result = await ipcApi.request('managed_chat.create_topic', { modelId })
      setSelectedModel(modelId)
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
    if (!restored) {
      if (first.topics.length) setTopicId(first.topics[0].id)
      else void create(first.id)
    }
  }, [models, topicId])
  useEffect(() => {
    const update = () => setReading(!document.hidden && document.hasFocus())
    window.addEventListener('focus', update)
    window.addEventListener('blur', update)
    document.addEventListener('visibilitychange', update)
    return () => {
      window.removeEventListener('focus', update)
      window.removeEventListener('blur', update)
      document.removeEventListener('visibilitychange', update)
    }
  }, [])
  useEffect(() => {
    if (!models.length) return
    setReadReceipts((old) => {
      const next = { ...old }
      let changed = false
      const ids = new Set(models.flatMap((model) => model.topics.map((item) => item.id)))
      for (const model of models)
        for (const item of model.topics) {
          if (next[item.id] === undefined || (item.id === topicId && reading && item.latestReplyAt > next[item.id])) {
            next[item.id] = item.latestReplyAt
            changed = true
          }
        }
      for (const id of Object.keys(next))
        if (!ids.has(id)) {
          delete next[id]
          changed = true
        }
      return changed ? next : old
    })
  }, [models, topicId, reading, setReadReceipts])
  const unread = new Set(
    models.flatMap((model) =>
      model.topics
        .filter(
          (item) =>
            item.latestReplyAt > (readReceipts[item.id] ?? item.latestReplyAt) && !(item.id === topicId && reading)
        )
        .map((item) => item.id)
    )
  )
  const remove = async (id: string) => {
    if (deleting.current) return false
    deleting.current = true
    setRemoving(true)
    setError('')
    try {
      if (classifyTurn(cacheService.getShared(`topic.stream.statuses.${id}`)?.status).isStreamLive)
        throw new Error(t('api_managed.delete_busy'))
      const result = await ipcApi.request('trash.topic.archive', { topicIds: [id] })
      if (!result.deletedIds.includes(id)) throw new Error(t('common.error'))
      if (topicId === id) {
        const next = models.find((model) => model.id === selectedModel)?.topics.find((item) => item.id !== id)
        setTopicId(next?.id || null)
      }
      await reload()
      setPendingDelete(null)
      return true
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t('common.error'))
      return false
    } finally {
      deleting.current = false
      setRemoving(false)
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
      <ManagedChatSidebar
        models={models}
        selectedModel={selectedModel}
        topicId={topicId}
        unread={unread}
        onModel={(model) => void chooseModel(model)}
        onTopic={setTopicId}
        onCreate={() => void create()}
        creating={creating}
        onRename={(id, name) => void rename(id, name)}
        onExport={(id) => void exportConversation(id)}
        onDelete={(item) => {
          setError('')
          setPendingDelete(item)
        }}
      />
      <ConfirmDialog
        open={Boolean(pendingDelete)}
        destructive
        title={t('api_managed.delete_confirm', { name: pendingDelete?.name || t('api_managed.new_topic') })}
        description={t('api_managed.delete_hint')}
        confirmText={t('api_managed.delete_topic')}
        cancelText={t('common.cancel')}
        confirmLoading={removing}
        cancelDisabled={removing}
        onOpenChange={(open) => {
          if (!open && !removing) {
            setPendingDelete(null)
            setError('')
          }
        }}
        onConfirm={() => (pendingDelete ? remove(pendingDelete.id) : false)}
        content={
          error ? (
            <p role="alert" className="text-xs text-error">
              {error}
            </p>
          ) : undefined
        }
      />
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        {selectedModel && !models.find((model) => model.id === selectedModel)?.available && (
          <p role="status" className="px-4 py-2 text-xs text-muted-foreground">
            {t('code.model_required')}
          </p>
        )}
        {(error || workspaceError) && !pendingDelete && (
          <p role="alert" className="px-4 py-2 text-xs text-error">
            {error || workspaceError}
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
