import { resolve } from 'node:path'

import { defineConfig } from 'electron-vite'

import original from './electron.vite.config'

const config = original as Exclude<typeof original, Function>

config.main!.define = { ...config.main!.define, 'process.env.API_CHAT_BUILD': JSON.stringify('1') }
config.main!.build!.lib = { entry: resolve('src/main/services/managedChat/managedEntryPoint.ts'), formats: ['cjs'], fileName: () => 'main.js' }
config.renderer!.define = { ...config.renderer!.define, 'process.env.API_CHAT_BUILD': JSON.stringify('1') }
config.renderer!.resolve!.alias = {
  '@renderer/routeTree.gen': resolve('src/renderer/windows/main/managedRouteTree.ts'),
  ...config.renderer!.resolve!.alias
}
config.renderer!.build!.rolldownOptions!.input = {
  index: resolve('src/renderer/windows/main/index.html'),
  subWindow: resolve('src/renderer/windows/subWindow/index.html')
}
config.renderer!.plugins!.push({
  name: 'api-chat-entry',
  enforce:'pre',
  transformIndexHtml:{order:'pre',handler(html){return html.replace('/windows/main/entryPoint.tsx','/windows/main/managedEntryPoint.tsx')}},
  resolveId(id, importer) {
    if (id === './MainApp' && importer?.replaceAll('\\', '/').endsWith('/windows/main/entryPoint.tsx')) {
      return resolve('src/renderer/windows/main/ManagedMainApp.tsx')
    }
  }
})

export default defineConfig(config)
