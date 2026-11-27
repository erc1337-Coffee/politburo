// What a board's policy finds in Node, loaded the first time a board serves: the OIDC tokens made
// out to it. A board served from Node names no project or team of its own.
import type { ProjectIdentity } from './policy.ts'
export { oidcTokens } from './tokens.ts'

export const ownProjectId = async (): Promise<string | null> => null
export const ownTeamId = async (): Promise<string | null> => null
export const discoveryIdentity = async (): Promise<ProjectIdentity> => ({ projectId: null, teamId: null })
