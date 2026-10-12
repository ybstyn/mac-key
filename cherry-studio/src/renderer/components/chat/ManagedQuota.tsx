import { ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@cherrystudio/ui'
import { ipcApi } from '@renderer/ipc/ipcApi'
import type { OutputFor } from '@shared/ipc/types'

type Bucket = {
  label: string
  remaining: number | null
  amount: string | null
  unit: string
  reset: string
  stale: boolean
}

export function ManagedQuota() {
  const { t } = useTranslation()
  const [info, setInfo] = useState<OutputFor<'managed_chat.info'> | null>(null)
  const [buckets, setBuckets] = useState<Bucket[]>([])
  const [failed, setFailed] = useState(false)
  const [page, setPage] = useState(0)
  const [updating, setUpdating] = useState(false)

  useEffect(() => {
    let alive = true
    void ipcApi.request('managed_chat.info').then((value) => {
      if (alive) setInfo(value)
    })
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    if (!info?.enabled) return
    let alive = true
    const update = async () => {
      try {
        const value = await ipcApi.request('managed_chat.quota')
        if (!alive) return
        const items = value.accounts.flatMap((account, index) => {
          const rows = account.quota?.buckets
          if (!rows?.length)
            return [
              {
                label:
                  (account.platform === 'claude' ? 'Claude · ' : 'Gemini · ') +
                  t('api_managed.account', { number: index + 1 }),
                remaining: null,
                amount: null,
                unit: '',
                reset: '',
                stale: true
              }
            ]
          return rows.map((row) => ({
            label: (account.platform === 'claude' ? 'Claude · ' : 'Gemini · ') + row.modelId,
            remaining: row.remainingFraction,
            amount: row.remainingAmount == null ? null : String(row.remainingAmount),
            unit: row.tokenType || '',
            reset: row.resetTime || '',
            stale: Boolean(account.stale)
          }))
        })
        setBuckets(items)
        setFailed(false)
      } catch {
        if (alive) setFailed(true)
      }
    }
    void update()
    const timer = setInterval(() => {
      if (!document.hidden) void update()
    }, 30000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [info?.enabled, t, updating])

  if (!info?.enabled) return null
  const pages = Math.max(1, Math.ceil(buckets.length / 2)),
    currentPage = Math.min(page, pages - 1)
  return (
    <section data-ui="api-managed.quota" className="shrink-0 space-y-2 px-3 py-3">
      <div className="flex min-w-0 items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>{t('api_managed.quota')}</span>
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          aria-label={t('api_managed.refresh')}
          onClick={() => setUpdating(!updating)}>
          <RefreshCw className="size-3" />
        </Button>
      </div>
      {buckets.slice(currentPage * 2, currentPage * 2 + 2).map((bucket, index) => (
        <div key={index} className="min-w-0 rounded-lg border border-border-subtle bg-card px-3 py-2">
          <div className="flex min-w-0 items-start justify-between gap-2">
            <span className="min-w-0 break-words text-xs leading-normal text-muted-foreground">{bucket.label}</span>
            <span className="shrink-0 text-sm font-medium tabular-nums">
              {typeof bucket.remaining === 'number' &&
              Number.isFinite(bucket.remaining) &&
              bucket.remaining >= 0 &&
              bucket.remaining <= 1
                ? Math.round(bucket.remaining * 100) + '%'
                : t('languages.unknown')}
            </span>
          </div>
          {bucket.amount !== null && (
            <div className="mt-1 break-words text-[11px] leading-normal text-muted-foreground">
              {bucket.unit} {bucket.amount}
            </div>
          )}
          {bucket.reset && (
            <div className="mt-1 text-[10px] leading-normal text-foreground-tertiary">
              {t('api_managed.reset', { time: new Date(bucket.reset).toLocaleString() })}
            </div>
          )}
        </div>
      ))}
      <div className="flex items-center justify-between gap-2 text-[10px] text-foreground-tertiary">
        <span>{failed ? t('api_managed.stale') : t('api_managed.cached')}</span>
        {pages > 1 && (
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="size-5"
              disabled={currentPage === 0}
              aria-label={t('api_managed.previous')}
              onClick={() => setPage(currentPage - 1)}>
              <ChevronLeft className="size-3" />
            </Button>
            <span>
              {currentPage + 1}/{pages}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="size-5"
              disabled={currentPage === pages - 1}
              aria-label={t('api_managed.next')}
              onClick={() => setPage(currentPage + 1)}>
              <ChevronRight className="size-3" />
            </Button>
          </div>
        )}
      </div>
    </section>
  )
}
