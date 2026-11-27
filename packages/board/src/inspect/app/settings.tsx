import { Check, ChevronsUpDown } from 'lucide-react'
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { Me } from '../../api/routes.ts'
import * as board from './board.ts'
import { buttonSoundsEnabled, setButtonSounds } from './button-feedback.ts'
import { Access } from './grants.tsx'
import { IdentitiesSection } from './identities-section.tsx'
import { Ago, here, Link, SECTIONS, type Section, type Where } from './nav.tsx'
import { Schemas } from './schemas.tsx'
import { mayCancelSchedule, nameOf, type State, type Viewer } from './store.ts'
import { AskForm, Header, Menu, MenuItem, MenuSeparator, nativeMenu, Panel, Unlisted } from './ui.tsx'

import { cadence, firstLine, said, shownName, until } from './words.ts'

// The board's configuration, apart from what's said on it: who gets in, what blocks can hold,
// what posts later, and what watches. One view, a tab per section.

const ActionsSlot = createContext<HTMLElement | null>(null)

/** A section's own actions, at the end of the tabs' row. */
export function Actions({ children }: { children: ReactNode }) {
  const slot = useContext(ActionsSlot)
  return slot ? createPortal(children, slot) : null
}

export function Settings(props: { state: State; viewer: Viewer; now: number; lead: ReactNode; where: Where; section: Section; open: string | null }) {
  const { state, viewer, section } = props
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  const [sounds, setSounds] = useState(buttonSoundsEnabled)
  const sections = SECTIONS.filter((name) => name !== 'watchers' || viewer.manages || section === 'watchers')
  return (
    <>
      <Header title="settings" lead={props.lead} flat>
        <label className="button-sounds">
          <input type="checkbox" checked={sounds} onChange={(event) => {
            setButtonSounds(event.target.checked)
            setSounds(event.target.checked)
          }} />
          button sounds
        </label>
      </Header>
      <div className="view-body">
      <nav className="tabs">
        {sections.map((name) => (
          <Link key={name} to={`/settings/${name}`} className="tab" current={name === section}>
            {name}
          </Link>
        ))}
        <span className="tab-actions" ref={setSlot} />
      </nav>
      <ActionsSlot.Provider value={slot}>
        <div className="page">
          <DeveloperIdentity me={state.me!} />
          {section === 'access' && <Access state={state} viewer={viewer} where={props.where} />}
          {section === 'identities' && <IdentitiesSection state={state} viewer={viewer} />}
          {section === 'schemas' && <Schemas state={state} viewer={viewer} selected={props.open} />}
          {section === 'schedules' && <Schedules state={state} viewer={viewer} now={props.now} all={props.where.params.get('show') === 'all'} />}
          {section === 'watchers' && <Watchers state={state} />}
        </div>
      </ActionsSlot.Provider>
      </div>
    </>
  )
}

function DeveloperIdentity({ me }: { me: Me }) {
  const [editing, setEditing] = useState<board.Profile | null>(null)
  const anchor = useRef<HTMLDivElement>(null)
  const remembered = (name: string) => {
    const avatar = board.avatarOf(name)
    return avatar ? { name, avatar } : { name }
  }
  return (
    <details className="developer-identity">
      <summary>developer options</summary>
      <div className="profile-options" ref={anchor}>
        <Menu className="act" title="post as" trigger={<>post as… <ChevronsUpDown size={13} /></>}>
          {!board.named && <MenuItem onClick={() => void board.setProfile(null)}>act as yourself</MenuItem>}
          <MenuSeparator />
          {me.profile !== null && <MenuItem onClick={() => setEditing(remembered(me.profile!))}>change name or avatar…</MenuItem>}
          <MenuItem onClick={() => setEditing({ name: '' })}>another profile…</MenuItem>
          {!board.named && board.getProfile() !== undefined && <MenuItem onClick={() => void board.setProfile(undefined)}>as inspect started</MenuItem>}
        </Menu>
        <Panel title="post as a profile" anchor={anchor} open={editing !== null} onOpenChange={(shown) => !shown && setEditing(null)}>
          {editing && <AskForm
            fields={[
              { name: 'name', placeholder: 'profile name', required: true, value: editing.name },
              { name: 'avatar', placeholder: 'avatar URL (optional)', value: editing.avatar ?? '' },
            ]}
            submit="post as this"
            onDone={() => setEditing(null)}
            onSubmit={({ name, avatar }) => void board.setProfile({ name: name!, ...(avatar ? { avatar } : {}) })}
          />}
        </Panel>
      </div>
    </details>
  )
}

// --- schedules ---------------------------------------------------------------------------------

function Schedules({ state, viewer, now, all }: { state: State; viewer: Viewer; now: number; all: boolean }) {
  useEffect(() => {
    void board.loadSchedules(all)
  }, [all])
  const listed = state.everySchedule === all ? state.schedules : { is: 'loading' as const }
  return (
    <>
      <Actions>
        <Link to="/settings/schedules" className="tab" current={!all}>pending</Link>
        <Link to="/settings/schedules?show=all" className="tab" current={all}>all</Link>
      </Actions>
      <Unlisted listed={listed} />
      {listed.is === 'here' && listed.items.length === 0 && <p className="empty">nothing scheduled</p>}
      {listed.is === 'here' &&
        listed.items.map((schedule) => (
          <div key={schedule.id} className="sched-row" {...nativeMenu}>
            <span className={schedule.state === 'pending' ? 'sched-when' : 'sched-when faint'} title={schedule.next ? new Date(schedule.next).toLocaleString() : undefined}>
              {schedule.state === 'pending' && schedule.next ? until(schedule.next, now) : schedule.state}
            </span>
            <span className="faint">{cadence(schedule)}</span>
            <span className="sched-text">{firstLine(schedule.text) || 'files only'}</span>
            {schedule.re === null ? (
              <Link to={`/c/${schedule.channel}`} className="text-link">#{schedule.channel}</Link>
            ) : (
              <Link to={here({ thread: schedule.re })} className="text-link">reply in #{schedule.channel}</Link>
            )}
            <span className="faint small">{shownName(schedule.author)}</span>
            {schedule.state === 'pending' && mayCancelSchedule(viewer, schedule) ? (
              <button className="act quiet" type="button" onClick={() => void board.cancelSchedule(schedule.id)}>cancel</button>
            ) : (
              <span />
            )}
          </div>
        ))}
    </>
  )
}

// --- watchers ----------------------------------------------------------------------------------

/** What boards elsewhere registered here, and what each tails. Read-only: a board registers its own. */
function Watchers({ state }: { state: State }) {
  useEffect(() => {
    void board.loadWatchers()
  }, [])
  const listed = state.watchers
  return (
    <>
      <Unlisted listed={listed} />
      {listed.is === 'here' && listed.items.length === 0 && <p className="empty">no watchers registered</p>}
      {listed.is === 'here' &&
        listed.items.map((registration) => (
          <section key={registration.owner} className="registration" {...nativeMenu}>
            <h3>
              <b>{nameOf(state, registration.owner)}</b>
              {' · pulls on its own'}
            </h3>
            {Object.entries(registration.watch).map(([id, watcher]) => (
              <div key={id} className="watch-row">
                <span className="watch-id">{id}</span>
                <code>{watcher.tail}</code>
              </div>
            ))}
          </section>
        ))}
    </>
  )
}
