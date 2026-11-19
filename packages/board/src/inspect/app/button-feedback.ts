const preference = 'board.button-sounds'
const majorPentatonic = [0, 2, 4, 7, 9]
let enabled = true
let context: AudioContext | undefined
let previousNote: number | undefined

export function buttonSoundsEnabled() {
  return enabled
}

export function setButtonSounds(enabledNow: boolean) {
  enabled = enabledNow
  try { localStorage.setItem(preference, enabled ? 'on' : 'off') } catch { /* optional storage */ }
}

export function installButtonFeedback(root: HTMLElement) {
  try { enabled = localStorage.getItem(preference) !== 'off' } catch { /* optional storage */ }
  // Native click covers pointer, touch, and keyboard activation without pairing
  // pointer/key events with the click they synthesize.
  root.addEventListener('click', (event) => {
    if (!enabled || !event.isTrusted || event.defaultPrevented) return
    const button = event.target instanceof Element && event.target.closest('button')
    if (!button || !root.contains(button) || button.closest(':disabled, [aria-disabled="true"], [inert]')) return
    void thunk()
  }, { capture: true })
}

async function thunk() {
  try {
    if (!context || context.state === 'closed') context = new AudioContext()
    const audio = context
    if (audio.state !== 'running') {
      const clickedAt = performance.now()
      await audio.resume()
      if (performance.now() - clickedAt > 150) return
    }
    if (!enabled || audio.state !== 'running') return

    // Draw uniformly from the scale, excluding the last note. Both hits use
    // this draw, rooted at C2 to keep the feedback percussive rather than bright.
    const choices = majorPentatonic.filter((note) => note !== previousNote)
    const note = choices[Math.floor(Math.random() * choices.length)]!
    previousNote = note
    const pitch = 65.406 * 2 ** (note / 12)
    const start = audio.currentTime
    hit(audio, start, pitch, 0.085)
    hit(audio, start + 0.052, pitch, 0.049)
  } catch {
    // Unsupported or blocked audio must not interfere with the action.
  }
}

function hit(audio: AudioContext, start: number, pitch: number, level: number) {
  const oscillator = audio.createOscillator()
  const filter = audio.createBiquadFilter()
  const envelope = audio.createGain()
  oscillator.type = 'sawtooth'
  oscillator.frequency.value = pitch
  filter.type = 'lowpass'
  filter.frequency.value = 500
  envelope.gain.setValueAtTime(0, start)
  envelope.gain.linearRampToValueAtTime(level, start + 0.004)
  envelope.gain.exponentialRampToValueAtTime(0.0001, start + 0.045)
  oscillator.connect(filter).connect(envelope).connect(audio.destination)
  oscillator.onended = () => {
    oscillator.disconnect()
    filter.disconnect()
    envelope.disconnect()
  }
  oscillator.start(start)
  oscillator.stop(start + 0.046)
}
