import { useEffect, useRef, useState } from 'react'
import { IDENTITY_AVATAR_MAX } from '../../contract/identities.ts'
import * as board from './board.ts'
import { SERVICES, type Shown } from './identity.ts'
import { Avatar } from './message.tsx'
import { orchestratorActor } from './operations-view.tsx'
import { nameOf, type State, type Viewer } from './store.ts'
import { shownName } from './words.ts'

// /settings/identities: how the board shows you, the orchestrator, the relay and the worker. A name
// and a picture each, which every page reading this board shows in place of their own.

const SIDE = 128
const PICTURES = 'image/png,image/jpeg,image/webp,image/gif'

/** A picture as the board keeps one: the file's middle square at 128 pixels, inline, small enough to keep. */
export async function squarePicture(file: Blob): Promise<string> {
  const bitmap = await createImageBitmap(file)
  const side = Math.min(bitmap.width, bitmap.height)
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = SIDE
  canvas.getContext('2d')!.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, SIDE, SIDE)
  bitmap.close()
  for (const [type, quality] of [['image/webp', 0.85], ['image/jpeg', 0.8], ['image/png', undefined]] as const) {
    const url = canvas.toDataURL(type, quality)
    // A browser that can't write a type writes PNG instead.
    if (url.startsWith(`data:${type};`) && url.length <= IDENTITY_AVATAR_MAX) return url
  }
  throw new Error('the picture is too large to keep')
}

type Entry = { key: string; label: string; fallback: string; about: string }

export function IdentitiesSection({ state, viewer }: { state: State; viewer: Viewer }) {
  // undefined: still asking. null: no orchestrator answers this inspector.
  const [orchestrator, setOrchestrator] = useState<string | null | undefined>(undefined)
  useEffect(() => {
    void board.loadIdentities()
    let current = true
    void orchestratorActor().then((actor) => { if (current) setOrchestrator(actor) })
    return () => { current = false }
  }, [])
  const me = state.me!
  const entries: (Entry | { label: string; missing: string })[] = [
    { key: me.actor, label: 'You', fallback: shownName(me), about: 'your messages, as everyone reading this board sees them' },
    orchestrator
      ? { key: orchestrator, label: 'Orchestrator', fallback: nameOf(state, orchestrator), about: 'its status lines and messages, and Operations' }
      : { label: 'Orchestrator', missing: orchestrator === undefined ? 'looking for the orchestrator…' : 'no orchestrator answers this inspector' },
    { key: 'relay', label: SERVICES.relay, fallback: SERVICES.relay, about: 'Operations' },
    { key: 'worker', label: SERVICES.worker, fallback: SERVICES.worker, about: 'worker rounds in task threads, and each worker in Operations' },
  ]
  return (
    <section className="identities">
      {!viewer.manages && <p className="faint">Naming needs manage at *. These are the names the board shows.</p>}
      {entries.map((entry) =>
        'missing' in entry ? (
          <div key={entry.label} className="identity">
            <Avatar name={entry.label} size={40} />
            <div className="identity-body">
              <span className="identity-label">{entry.label}</span>
              <span className="faint">{entry.missing}</span>
            </div>
          </div>
        ) : (
          <IdentityRow key={`${entry.key}:${JSON.stringify(state.identities[entry.key] ?? null)}`} entry={entry}
            stored={Object.hasOwn(state.identities, entry.key) ? state.identities[entry.key]! : null} may={viewer.manages} />
        ),
      )}
    </section>
  )
}

function IdentityRow({ entry, stored, may }: { entry: Entry; stored: Shown | null; may: boolean }) {
  const [name, setName] = useState(stored?.name ?? '')
  const [avatar, setAvatar] = useState(stored?.avatar ?? null)
  const [problem, setProblem] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const file = useRef<HTMLInputElement>(null)
  const next: Shown = { name: name.trim() || null, avatar }
  const changed = next.name !== (stored?.name ?? null) || next.avatar !== (stored?.avatar ?? null)
  const save = async (shown: Shown) => {
    setSaving(true)
    setProblem(await board.saveIdentity(entry.key, shown))
    setSaving(false)
  }
  return (
    <div className="identity">
      <Avatar name={next.name ?? entry.fallback} src={avatar ?? undefined} size={40} />
      <div className="identity-body">
        <span className="identity-label">{entry.label} <span className="faint" title={entry.key}>· {entry.about}</span></span>
        <div className="identity-fields">
          <input aria-label={`${entry.label} name`} value={name} placeholder={entry.fallback} maxLength={64} disabled={!may}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter' && changed && !saving) void save(next) }} />
          {may && (
            <>
              <input ref={file} type="file" accept={PICTURES} hidden onChange={(event) => {
                const chosen = event.target.files?.[0]
                event.target.value = ''
                if (!chosen) return
                squarePicture(chosen).then((url) => { setAvatar(url); setProblem(null) }, (error: Error) => setProblem(error.message))
              }} />
              <button className="act" onClick={() => file.current?.click()}>{avatar ? 'change picture' : 'choose picture'}</button>
              {avatar && <button className="act" onClick={() => setAvatar(null)}>remove picture</button>}
              <button className="act" disabled={!changed || saving} onClick={() => void save(next)}>save</button>
              {stored && <button className="act" disabled={saving} onClick={() => void save({ name: null, avatar: null })}>reset</button>}
            </>
          )}
        </div>
        {problem && <span className="error-text">{problem}</span>}
      </div>
    </div>
  )
}
