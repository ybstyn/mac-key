import { ArrowLeft, Settings } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@cherrystudio/ui'
import { ManagedKeyButton } from '@renderer/components/chat/ManagedKeyButton'
import { TabRouter } from '@renderer/components/layout/TabRouter'
import { ResourceViewSourceProvider } from '@renderer/components/ResourceViewSourceProvider'
import { WindowControls } from '@renderer/components/WindowControls'
import { useTabs } from '@renderer/hooks/tab'
import { ipcApi } from '@renderer/ipc'
import { isMac } from '@renderer/utils/platform'
import type { OutputFor } from '@shared/ipc/types'

export function ManagedShell() {
  const { t } = useTranslation()
  const { tabs, activeTabId, updateTab, setActiveTab } = useTabs()
  const [info, setInfo] = useState<OutputFor<'managed_chat.info'> | null>(null)
  useEffect(() => {
    void ipcApi.request('managed_chat.info').then(setInfo)
  }, [])
  const active = tabs.find((tab) => tab.id === activeTabId) || tabs[0]
  const setting = active?.url.startsWith('/settings')
  const settings = () => {
    const home = tabs.find((tab) => tab.id === 'home') || active
    if (home) {
      updateTab(home.id, { url: setting ? '/app/chat' : '/settings/appearance' })
      setActiveTab(home.id)
    }
  }
  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
      <header
        className={'flex h-14 shrink-0 items-center gap-3 px-4 [-webkit-app-region:drag]' + (isMac ? ' pl-20' : '')}>
        {info && (
          <>
            <div className="flex size-7 items-center justify-center rounded-md bg-foreground p-1">
              <img src={info.icon} alt="API" className="size-full object-contain brightness-0 invert dark:invert-0" />
            </div>
            <span className="text-sm font-medium">{info.name}</span>
          </>
        )}
        <div className="flex-1" />
        <div className="flex items-center gap-1 [-webkit-app-region:no-drag]">
          <ManagedKeyButton />
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label={setting ? t('api_managed.back') : t('settings.title')}
            onClick={settings}>
            {setting ? <ArrowLeft className="size-4" /> : <Settings className="size-4" />}
          </Button>
          <WindowControls />
        </div>
      </header>
      <div className="relative flex min-h-0 flex-1">
        <ResourceViewSourceProvider>
          {tabs
            .filter((tab) => tab.type === 'route' && !tab.isDormant)
            .map((tab) => (
              <TabRouter
                key={tab.id}
                tab={tab}
                isActive={tab.id === active?.id}
                onUrlChange={(url) => updateTab(tab.id, { url })}
              />
            ))}
        </ResourceViewSourceProvider>
      </div>
    </div>
  )
}
