import { z } from 'zod'

const id = z.string().min(1).max(64)

export const chatMessageSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  createdAt: z.number()
})

export const sendMessageInputSchema = z.object({
  projectId: id,
  text: z.string().trim().min(1, 'Message is empty').max(20_000)
})
export const projectIdInputSchema = z.object({ projectId: id })

export const sendMessageResultSchema = z.object({ turnId: z.string(), userMessage: chatMessageSchema })

/** Events pushed from main to the renderer. Every event is scoped by projectId. */
export const appEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('turn_started'), projectId: z.string(), turnId: z.string(), purpose: z.enum(['chat', 'onboarding', 'review']) }),
  z.object({ type: z.literal('text_delta'), projectId: z.string(), turnId: z.string(), text: z.string() }),
  z.object({ type: z.literal('tool_activity'), projectId: z.string(), turnId: z.string(), tool: z.string() }),
  z.object({ type: z.literal('turn_completed'), projectId: z.string(), turnId: z.string(), messageId: z.string().nullable() }),
  z.object({ type: z.literal('turn_error'), projectId: z.string(), turnId: z.string(), code: z.string(), message: z.string() }),
  z.object({ type: z.literal('project_updated'), projectId: z.string() }),
  z.object({ type: z.literal('tasks_changed'), projectId: z.string() }),
  z.object({ type: z.literal('proposals_changed'), projectId: z.string() }),
  z.object({ type: z.literal('agent_changed'), projectId: z.string(), agentId: z.string() }),
  z.object({ type: z.literal('plans_changed'), projectId: z.string(), taskId: z.string() }),
  z.object({ type: z.literal('executions_changed'), projectId: z.string(), taskId: z.string() })
])

export type ChatMessage = z.infer<typeof chatMessageSchema>
export type SendMessageResult = z.infer<typeof sendMessageResultSchema>
export type AppEvent = z.infer<typeof appEventSchema>
