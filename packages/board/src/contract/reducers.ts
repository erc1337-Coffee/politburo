// The board's views as A2 reducers: the folds in `folds.ts`, named and seeded for the engine.
// Only the local board's engine loads this module; anything else folds with `folds.ts` directly.
import { reducer } from 'experimental-a2'
import { boardContract } from './contract.ts'
import type { BoardEvent } from './events.ts'
import { foldActors, foldMessages, type ActorsState, type ChannelsState, type MessagesState } from './folds.ts'
import { own, setOwn } from './own.ts'
import type { AgentIntent, Author } from './schemas.ts'

export const messagesReducer = reducer({
  contract: boardContract,
  name: 'board.messages.v5',
  initialState: { byId: {}, replies: {} } as MessagesState,
}).fold(foldMessages)

/**
 * Each post's event ID → its message: a retried write with the same ID is already on
 * the board, and doesn't go through the middleware again.
 */
export const postedReducer = reducer({
  contract: boardContract,
  name: 'board.posted.v1',
  initialState: {} as Record<string, number>,
}).fold((state, event) => {
  if (event.type === 'message.posted') setOwn(state, event.id, event.index)
  return state
})

const emptyChannel = (path: string) => ({ path, lastIndex: 0, messages: 0, threads: 0 })

export const channelsReducer = reducer({
  contract: boardContract,
  // v2 folds `channel.created`: a v1 snapshot an older deployment made may have passed one by.
  name: 'board.channels.v2',
  initialState: {} as ChannelsState,
}).fold((state, event) => {
  if (event.type === 'channel.created') {
    if (!own(state, event.payload.channel)) setOwn(state, event.payload.channel, emptyChannel(event.payload.channel))
    return state
  }
  if (event.type !== 'message.posted') return state
  const { channel, re } = event.payload
  const entry = own(state, channel) ?? setOwn(state, channel, emptyChannel(channel))
  entry.lastIndex = event.index
  entry.messages += 1
  if (re === null) entry.threads += 1
  return state
})

export const actorsReducer = reducer({
  contract: boardContract,
  name: 'board.actors.v2',
  initialState: { byId: {}, byHandle: {} } as ActorsState,
}).fold(foldActors)

export const agentsReducer = reducer({
  contract: boardContract,
  name: 'board.agents.v1',
  initialState: {} as Record<string, BoardEvent<'ops.agent_changed'>['payload']['agent']>,
}).fold((state, event) => {
  if (event.type === 'ops.agent_changed') setOwn(state, event.payload.agent.id, event.payload.agent)
  return state
})

type Issue = BoardEvent<'ops.intents_issued'>['payload']
export const runKey = (task: number, epoch: number) => `${task}:${epoch}`

export type AgentIntentsState = {
  agents: Record<string, BoardEvent<'ops.agent_changed'>['payload']['agent']>
  intents: Record<string, { intent: AgentIntent; requestKey: string; order: number; offset: number }>
  issues: Record<string, { ids: string[]; hash: string; issuer: Issue['issuer'] }>
  byAgent: Record<string, string[]>
  claims: Record<string, Author>
  /** The newest reported probe per run, ordered by issue, never by receipt. */
  probes: Record<string, string>
}

export const agentIntentsReducer = reducer({
  contract: boardContract,
  name: 'board.agent-intents.v1',
  initialState: { agents: {}, intents: {}, issues: {}, byAgent: {}, claims: {}, probes: {} } as AgentIntentsState,
}).fold((state, event) => {
  switch (event.type) {
    case 'ops.agent_changed':
      setOwn(state.agents, event.payload.agent.id, event.payload.agent)
      break
    case 'task.claimed': {
      const { id, epoch, by } = event.payload
      const key = runKey(id, epoch)
      if (!own(state.claims, key)) setOwn(state.claims, key, by)
      break
    }
    case 'ops.intents_issued': {
      const { intents, requestKey, requestHash, issuer } = event.payload
      const ids: string[] = []
      for (const intent of intents) {
        const byAgent = own(state.byAgent, intent.agent) ?? setOwn(state.byAgent, intent.agent, [])
        setOwn(state.intents, intent.id, { intent, requestKey, order: event.index, offset: byAgent.length })
        byAgent.push(intent.id)
        ids.push(intent.id)
      }
      setOwn(state.issues, requestKey, { ids, hash: requestHash, issuer })
      break
    }
    case 'ops.intent_taken': {
      const row = own(state.intents, event.payload.intentId)
      if (row?.intent.state === 'pending') {
        row.intent.taken = event.payload.receipt
        row.intent.state = 'taken'
      }
      break
    }
    case 'ops.intent_reported': {
      const row = own(state.intents, event.payload.intentId)
      if (row?.intent.state !== 'taken') break
      row.intent.report = event.payload.receipt
      row.intent.state = 'reported'
      const run = row.intent.run
      if (run) {
        // Run refs on issue are canonical local task IDs, as returned by the task routes.
        const key = runKey(Number(run.task), run.epoch)
        const previous = own(state.probes, key)
        if (previous === undefined || state.intents[previous]!.order < row.order) setOwn(state.probes, key, row.intent.id)
      }
      break
    }
  }
  return state
})
