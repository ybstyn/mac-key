import { KeyRound } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Tooltip
} from '@cherrystudio/ui'
import { ipcApi } from '@renderer/ipc'

export function ManagedKeyButton() {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [gemini, setGemini] = useState('')
  const [claude, setClaude] = useState('')
  const [platforms, setPlatforms] = useState<string[]>([])
  const [tip, setTip] = useState(false)
  const [remember, setRemember] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!process.env.API_CHAT_BUILD) return
    const show = setTimeout(() => setTip(true), 1200)
    const hide = setTimeout(() => setTip(false), 7200)
    return () => {
      clearTimeout(show)
      clearTimeout(hide)
    }
  }, [])
  if (!process.env.API_CHAT_BUILD) return null
  const openKeys = () => {
    setTip(false)
    setError('')
    setOpen(true)
    void ipcApi.request('managed_chat.info').then((info) => setPlatforms(info.platforms))
  }
  const connect = async () => {
    if (busy || (!gemini.trim() && !claude.trim())) return
    setBusy(true)
    setError('')
    try {
      await ipcApi.request('managed_chat.connect_keys', { gemini: gemini.trim(), claude: claude.trim(), remember })
      setGemini('')
      setClaude('')
      setOpen(false)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t('api_managed.key_error'))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <Tooltip content={t('api_managed.key_tip')} placement="bottom-end" isOpen={tip && !open} onOpenChange={setTip}>
        <Button
          data-ui="api-managed.key.open"
          variant="ghost"
          size="icon"
          className="size-8"
          aria-label={t('api_managed.add_key')}
          onClick={openKeys}>
          <KeyRound className="size-4" />
        </Button>
      </Tooltip>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!busy) setOpen(value)
        }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('api_managed.add_key')}</DialogTitle>
            <DialogDescription>{t('api_managed.key_hint')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="managed-gemini-key">
              Gemini Key{' '}
              {platforms.includes('gemini') && (
                <span className="text-xs text-muted-foreground">{t('api_managed.key_saved')}</span>
              )}
            </Label>
            <Input
              id="managed-gemini-key"
              data-ui="api-managed.key.input.gemini"
              type="password"
              autoComplete="off"
              value={gemini}
              disabled={busy}
              placeholder={platforms.includes('gemini') ? t('api_managed.key_keep') : t('api_managed.key_gemini')}
              onChange={(event) => setGemini(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void connect()
              }}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="managed-claude-key">
              Claude Key{' '}
              {platforms.includes('claude') && (
                <span className="text-xs text-muted-foreground">{t('api_managed.key_saved')}</span>
              )}
            </Label>
            <Input
              id="managed-claude-key"
              data-ui="api-managed.key.input.claude"
              type="password"
              autoComplete="off"
              value={claude}
              disabled={busy}
              placeholder={platforms.includes('claude') ? t('api_managed.key_keep') : t('api_managed.key_claude')}
              onChange={(event) => setClaude(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void connect()
              }}
            />
          </div>
          <p className="text-xs leading-5 text-muted-foreground">{t('api_managed.key_isolation')}</p>
          <Label className="flex items-center gap-2">
            <Checkbox checked={remember} disabled={busy} onCheckedChange={(value) => setRemember(value === true)} />
            {t('api_managed.remember')}
          </Label>
          {error && (
            <p role="alert" className="break-words text-sm text-error">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              data-ui="api-managed.key.connect"
              disabled={busy || (!gemini.trim() && !claude.trim())}
              onClick={() => void connect()}>
              {busy ? t('common.loading') : t('api_managed.connect')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
