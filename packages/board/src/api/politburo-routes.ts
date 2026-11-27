import { z } from 'zod'
import { CHANNEL_PATTERN_MAX, TaskNote, TaskPriority } from '../contract/schemas.ts'
import { AttentionAnswerBody, RequestAttentionBody } from '../contract/attention.ts'
import { TaskPacket } from '../contract/task-authority.ts'
import type { GrantCan } from './routes.ts'

/** Why a person is pausing or resuming the board. The authority supplies the audit author. */
export const ControlBody = z.strictObject({ reason: TaskNote })

/** A board's work admission and its pause fence. The epoch advances on each transition to paused. */
export const BoardStatus = z.object({ paused: z.boolean(), pauseEpoch: z.number().int().nonnegative() })
export type BoardStatus = z.infer<typeof BoardStatus>

export const controlRoutes = {
  /** The board's current work admission and pause epoch. */
  status: { method: 'GET', path: '/control' },
  /** Pauses work admission; requires a person with global manage. */
  pause: { method: 'POST', path: '/control/pause', body: ControlBody },
  /** Resumes work admission; requires a person with global manage. */
  resume: { method: 'POST', path: '/control/resume', body: ControlBody },
} as const

export const attentionRoutes = {
  requestTaskAttention: { method: 'POST', path: '/tasks/:id/attention', body: RequestAttentionBody },
  taskAttention: { method: 'GET', path: '/tasks/:id/attention' },
  answerTaskAttention: { method: 'POST', path: '/tasks/:id/attention/:requestId/answer', body: AttentionAnswerBody },
} as const

type ClaimFields = { epoch: z.ZodNumber; token: z.ZodString }

export function taskPriority(Claimed: ClaimFields) {
  /** The owner or manage sets priority; a live claim can only lower it. */
  const TaskPriorityBody = z.object({
    priority: TaskPriority,
    epoch: Claimed.epoch.optional(),
    token: Claimed.token.optional(),
  }).refine((body) => (body.epoch === undefined) === (body.token === undefined), { message: 'a claim is its `epoch` and its `token`: pass both, or neither' })
  const taskPriorityRoutes = {
    setTaskPriority: { method: 'POST', path: '/tasks/:id/priority', body: TaskPriorityBody },
  } as const
  return { TaskPriorityBody, taskPriorityRoutes }
}

export function taskAuthority(Claimed: ClaimFields) {
  const ParkTaskBody = z.strictObject({ reason: TaskNote })
  const HandoffTaskBody = TaskPacket.extend(Claimed)
  const taskAuthorityRoutes = {
    /** A verified person with manage parks or unparks a task. A park ends its claim. */
    parkTask: { method: 'POST', path: '/tasks/:id/park', body: ParkTaskBody },
    unparkTask: { method: 'POST', path: '/tasks/:id/unpark', body: ParkTaskBody },
    /** Records a packet reference and hash under a live claim; it verifies no external bytes. */
    handoffTask: { method: 'POST', path: '/tasks/:id/handoff', body: HandoffTaskBody },
  } as const
  return { ParkTaskBody, HandoffTaskBody, taskAuthorityRoutes }
}

export const INVITE_PERMISSIONS = ['read', 'post', 'react', 'label', 'sync'] as const
export const CreateInviteBody = z.strictObject({
  name: z.string().regex(/^[A-Za-z][A-Za-z0-9-]{0,31}$/, 'names start with a letter and use up to 32 letters, numbers, and hyphens'),
  can: z.record(z.string().min(1).max(CHANNEL_PATTERN_MAX), z.array(z.enum(INVITE_PERMISSIONS)).max(INVITE_PERMISSIONS.length)).optional(),
  expiresIn: z.number().int().min(1).max(604800).optional(),
})
export const RedeemInviteBody = z.strictObject({ secret: z.string().regex(/^vbi_[A-Za-z0-9_-]{43}$/) })

export type CreateInviteInput = { name: string; can?: GrantCan; expiresIn?: number }
export type InviteView = {
  id: string
  name: string
  can: Record<string, (typeof INVITE_PERMISSIONS)[number][]>
  expiresAt: string
  state: 'pending' | 'expired' | 'revoked' | 'redeemed'
}
export type CreatedInvite = { invite: InviteView; secret: string }
export type Joined = { principal: string; token: string }

export const inviteRoutes = {
  invites: { method: 'GET', path: '/invites' },
  createInvite: { method: 'POST', path: '/invites', body: CreateInviteBody },
  revokeInvite: { method: 'POST', path: '/invites/:id/revoke' },
  redeemInvite: { method: 'POST', path: '/invites/redeem', body: RedeemInviteBody },
} as const
