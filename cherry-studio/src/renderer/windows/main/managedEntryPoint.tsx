import '@renderer/assets/styles/index.css'
import '@renderer/assets/styles/tailwind.css'
import '@renderer/assets/styles/api-managed-chat.css'
import { createRoot } from 'react-dom/client'

import { prepareWindow } from '@renderer/windows/prepareWindow'

import ManagedMainApp from './ManagedMainApp'

await prepareWindow({ preference: 'all' })
createRoot(document.getElementById('root')!).render(<ManagedMainApp />)
