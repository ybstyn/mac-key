import { createRoute, redirect } from '@tanstack/react-router'

import { Route as root } from '@renderer/routes/__root'
import { Route as appImport } from '@renderer/routes/app'
import { Route as chatImport } from '@renderer/routes/app/chat'
import { Route as filePreviewImport } from '@renderer/routes/app/file-preview'
import { Route as settingsImport } from '@renderer/routes/settings'
import { Route as appearanceImport } from '@renderer/routes/settings/appearance'

import ManagedChatPage from './ManagedChatPage'

const app = appImport.update({ id: '/app', path: '/app', getParentRoute: () => root } as never)
const chat = chatImport.update({
  id: '/chat',
  path: '/chat',
  getParentRoute: () => app,
  component: ManagedChatPage
} as never)
const filePreview = filePreviewImport.update({
  id: '/file-preview',
  path: '/file-preview',
  getParentRoute: () => app
} as never)
const settings = settingsImport.update({ id: '/settings', path: '/settings', getParentRoute: () => root } as never)
const appearance = appearanceImport.update({
  id: '/appearance',
  path: '/appearance',
  getParentRoute: () => settings
} as never)
const settingsIndex = createRoute({
  getParentRoute: () => settings,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: '/settings/appearance' })
  }
})

export const routeTree = root.addChildren([
  app.addChildren([chat, filePreview]),
  settings.addChildren([appearance, settingsIndex])
])
