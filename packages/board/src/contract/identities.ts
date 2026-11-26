import { z } from 'zod'
import { Author } from './schemas.ts'

// How the board shows someone or something: a name and a picture that replace what it would show
// otherwise. A key is an actor's ID (`local:user:ada+orchestrator`), or a service the board talks
// about but that writes nothing itself (`relay`, `worker`). Pages apply them where they show a
// name; what the board stores of each message and what sync sends stay as written.

/** The longest picture the board keeps, as a data URL: a small square, never a full photo. */
export const IDENTITY_AVATAR_MAX = 64_000

export const IdentityKey = z.string().min(1).max(300).regex(/^\S+$/, 'expected a key without spaces')
export const IdentityName = z.string().trim().min(1).max(64)
/** A PNG, JPEG, WebP or GIF, inline: never a URL, which a page would fetch for every reader. */
export const IdentityAvatar = z
  .string()
  .max(IDENTITY_AVATAR_MAX, `a picture is at most ${IDENTITY_AVATAR_MAX} characters`)
  .regex(/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/, 'expected a PNG, JPEG, WebP or GIF data URL')

/** `null` takes back what the board showed before: the actor's own name, or no picture. */
export const SetIdentityBody = z.strictObject({ key: IdentityKey, name: IdentityName.nullable(), avatar: IdentityAvatar.nullable() })

export const identityEvents = {
  'identity.set': z.object({ key: IdentityKey, name: IdentityName.nullable(), avatar: IdentityAvatar.nullable(), by: Author }),
}

export type IdentityView = { key: string; name: string | null; avatar: string | null }
