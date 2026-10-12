import '@main/data/bootConfig'
import { app, protocol } from 'electron'

import { application } from '@application'
import { loggerService } from '@logger'
import { configureChromiumFlags } from '@main/core/preboot/chromiumFlags'
import { requireSingleInstance } from '@main/core/preboot/singleInstance'
import { resolveUserDataLocation } from '@main/core/preboot/userDataLocation'
import { registerIpc } from '@main/ipc'
import { CHERRY_MEDIA_SCHEME_DECLARATION } from '@main/services/mediaProtocol'
import { getApplicationId } from '@main/utils/appEdition'

import { managedServiceList } from './managedServiceRegistry'

resolveUserDataLocation()
requireSingleInstance()
configureChromiumFlags()
protocol.registerSchemesAsPrivileged([CHERRY_MEDIA_SCHEME_DECLARATION])
application.initPathRegistry()
app.setAppUserModelId(getApplicationId())

application.registerAll(managedServiceList)
const bootstrap = application.bootstrap()

void app
  .whenReady()
  .then(async () => {
    await bootstrap
    await registerIpc()
  })
  .catch((error) => {
    loggerService.withContext('ManagedChatEntry').error('Chat initialization failed', error)
    application.forceExit(1)
  })
