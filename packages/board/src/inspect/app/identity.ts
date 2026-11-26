import { createContext, useContext } from 'react'
import type { IdentityView } from '../../contract/identities.ts'

// How the board shows people, agents and services (`GET /identities`): a name and a picture by key,
// an actor's ID or a service's name. Every view that shows a name asks here first.

export type Shown = { name: string | null; avatar: string | null }
export type Identities = Readonly<Record<string, Shown>>

/** The services the board names that write nothing of their own. */
export const SERVICES = { relay: 'Relay', worker: 'Worker' } as const

export const identitiesOf = (list: readonly IdentityView[]): Identities =>
  Object.fromEntries(list.map(({ key, name, avatar }) => [key, { name, avatar }]))

const shown = (identities: Identities, key: string | undefined): Shown | undefined =>
  key !== undefined && Object.hasOwn(identities, key) ? identities[key] : undefined

/** The name the board gives `key`, or `fallback`, what it would show otherwise. */
export const nameFor = (identities: Identities, key: string | undefined, fallback: string): string => shown(identities, key)?.name ?? fallback
export const pictureFor = (identities: Identities, key: string | undefined): string | undefined => shown(identities, key)?.avatar ?? undefined

export const IdentitiesContext = createContext<Identities>({})
export const useIdentities = () => useContext(IdentitiesContext)
