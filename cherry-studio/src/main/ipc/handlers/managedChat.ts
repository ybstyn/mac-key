import { application } from '@application'
import type { managedChatRequestSchemas } from '@shared/ipc/schemas/managedChat'
import type { IpcHandlersFor } from '@shared/ipc/types'

export const managedChatHandlers: IpcHandlersFor<typeof managedChatRequestSchemas> = {
  'managed_chat.renderer_ready': () => application.get('ManagedChatService').rendererReady(),
  'managed_chat.info': () => application.get('ManagedChatService').getInfo(),
  'managed_chat.connect_key': ({ key, remember }) => application.get('ManagedChatService').connectKey(key, remember),
  'managed_chat.connect_keys': (keys) => application.get('ManagedChatService').connectKeys(keys),
  'managed_chat.workspace': async () => application.get('ManagedChatService').getWorkspace(),
  'managed_chat.create_topic': async ({ modelId }) => application.get('ManagedChatService').createTopic(modelId),
  'managed_chat.quota': () => application.get('ManagedChatService').getQuota()
}
