import { useEffect, useMemo } from 'react'

import {
  CORE_SIDEBAR_SHORTCUT_PROVIDERS,
  SidebarShortcutRegistry,
  SidebarShortcutRegistryProvider
} from '@renderer/components/app/sidebarShortcuts'
import { CodeStyleProvider } from '@renderer/components/CodeStyleProvider'
import { CommandContextKeyProvider, CommandProvider } from '@renderer/components/command'
import { ConversationNotificationRuntime } from '@renderer/components/ConversationNotificationRuntime'
import { ErrorBoundary } from '@renderer/components/ErrorBoundary'
import { TabsProvider } from '@renderer/components/layout/TabsProvider'
import { PopupHost } from '@renderer/components/PopupHost'
import { ThemeProvider } from '@renderer/components/ThemeProvider'
import ToastHost from '@renderer/components/ToastHost'
import { WindowFatalFallback } from '@renderer/components/WindowFatalFallback'
import { useMainWindowNavigation } from '@renderer/hooks/tab'
import { useWindowRuntime } from '@renderer/hooks/useWindowRuntime'
import { ipcApi } from '@renderer/ipc'
import type { Tab } from '@shared/data/cache/cacheValueTypes'

import { ManagedShell } from './ManagedShell'

function ManagedRuntime() {
  useWindowRuntime()
  useMainWindowNavigation()
  useEffect(() => {
    document.getElementById('spinner')?.remove()
    document.documentElement.dataset.apiManagedChat = 'true'
    void ipcApi.request('managed_chat.info').then((info) => {
      document.title = info.name + ' · API'
    })
  }, [])
  return null
}

export default function ManagedMainApp() {
  const tab = useMemo<Tab>(
    () => ({ id: 'home', type: 'route', url: '/app/chat', title: '', lastAccessTime: Date.now(), isDormant: false }),
    []
  )
  const registry = useMemo(() => new SidebarShortcutRegistry(CORE_SIDEBAR_SHORTCUT_PROVIDERS), [])
  return (
    <ErrorBoundary fallbackComponent={WindowFatalFallback}>
      <ThemeProvider>
        <CodeStyleProvider>
          <CommandContextKeyProvider>
            <CommandProvider>
              <TabsProvider initialDefaultTab={tab}>
                <SidebarShortcutRegistryProvider registry={registry}>
                  <ManagedShell />
                  <ManagedRuntime />
                  <ConversationNotificationRuntime />
                  <PopupHost />
                  <ToastHost />
                </SidebarShortcutRegistryProvider>
              </TabsProvider>
            </CommandProvider>
          </CommandContextKeyProvider>
        </CodeStyleProvider>
      </ThemeProvider>
    </ErrorBoundary>
  )
}
