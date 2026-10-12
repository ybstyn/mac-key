import * as z from 'zod'

import { defineRoute } from '../define'

const quotaBucket = z.object({
  modelId: z.string(),
  remainingFraction: z.number().nullable(),
  remainingAmount: z.union([z.number(), z.string()]).nullable().optional(),
  tokenType: z.string().optional(),
  resetTime: z.string().nullable().optional()
})

export const managedChatRequestSchemas = {
  'managed_chat.renderer_ready': defineRoute({ input: z.void(), output: z.void() }),
  'managed_chat.info': defineRoute({
    input: z.void(),
    output: z.object({
      enabled: z.boolean(),
      name: z.string(),
      icon: z.string(),
      platforms: z.array(z.enum(['claude', 'gemini']))
    })
  }),
  'managed_chat.connect_key': defineRoute({
    input: z.object({ key: z.string().min(1).max(4096), remember: z.boolean() }),
    output: z.object({ platform: z.enum(['claude', 'gemini']) })
  }),
  'managed_chat.connect_keys': defineRoute({
    input: z.object({ gemini: z.string().max(4096), claude: z.string().max(4096), remember: z.boolean() }),
    output: z.object({ platforms: z.array(z.enum(['claude', 'gemini'])), switched: z.boolean() })
  }),
  'managed_chat.workspace': defineRoute({
    input: z.void(),
    output: z.object({
      models: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          platform: z.enum(['claude', 'gemini']),
          available: z.boolean(),
          topics: z.array(
            z.object({ id: z.string(), name: z.string(), lastActivityAt: z.string(), latestReplyAt: z.number() })
          )
        })
      )
    })
  }),
  'managed_chat.create_topic': defineRoute({
    input: z.object({ modelId: z.string() }),
    output: z.object({ id: z.string() })
  }),
  'managed_chat.quota': defineRoute({
    input: z.void(),
    output: z.object({
      accounts: z.array(
        z.object({
          accountId: z.string().optional(),
          platform: z.enum(['claude', 'gemini']).optional(),
          stale: z.boolean().optional(),
          quota: z.object({ observedAt: z.string().optional(), buckets: z.array(quotaBucket) }).nullable()
        })
      )
    })
  })
}
