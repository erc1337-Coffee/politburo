// Animated schematics. Each <figure class="schematic"> holds an SVG and a JSON list of steps:
//   { "text": "...", "links": ["id", ...], "label": "start", "kind": "command", "nodes": ["id"], "states": ["id"] }
// A step moves one packet along each of its links in turn (right-angled polylines), highlights its
// nodes and states, and shows its text below the drawing. Steps repeat in a loop.
(() => {
  const SPEED = 110 // pixels per second along a link
  const MINIMUM_TRAVEL = 1600 // milliseconds per link, so a short link stays readable
  const HOLD = 1100 // milliseconds a step stays on screen after its packets arrive
  const STILL = 2400 // milliseconds for a step with no link
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches
  const SVG = 'http://www.w3.org/2000/svg'

  function colorOf(kind) {
    const name = { command: '--command', telemetry: '--telemetry', result: '--result', external: '--external' }[kind] || '--accent'
    return `var(${name})`
  }

  function setup(figure) {
    const svg = figure.querySelector('svg')
    const source = figure.querySelector('script.steps')
    if (!svg || !source) return
    const steps = JSON.parse(source.textContent)
    const caption = document.createElement('figcaption')
    caption.innerHTML = '<span class="step-number"></span><span class="step-text"></span><span class="controls"><button data-action="previous" aria-label="Previous step">◀</button><button data-action="toggle">Pause</button><button data-action="next" aria-label="Next step">▶</button></span>'
    figure.appendChild(caption)
    const number = caption.querySelector('.step-number')
    const text = caption.querySelector('.step-text')
    const toggle = caption.querySelector('[data-action="toggle"]')

    let index = -1
    let playing = true
    let visible = false
    let timer = 0
    let frame = 0
    let generation = 0

    const layer = document.createElementNS(SVG, 'g')
    svg.appendChild(layer)

    function clear() {
      cancelAnimationFrame(frame)
      clearTimeout(timer)
      layer.replaceChildren()
      svg.querySelectorAll('.active').forEach((element) => element.classList.remove('active'))
    }

    function travel(link, step, run, done) {
      if (run !== generation) return
      link.classList.add('active')
      if (reducedMotion) return done()
      const length = link.getTotalLength()
      const duration = Math.max(MINIMUM_TRAVEL, (length / SPEED) * 1000)
      const reverse = (step.reverse || []).includes(link.id)
      const packet = document.createElementNS(SVG, 'circle')
      packet.setAttribute('r', '6')
      packet.setAttribute('class', 'packet')
      packet.style.fill = colorOf(step.kind || link.dataset.kind)
      const label = document.createElementNS(SVG, 'text')
      label.setAttribute('class', 'packet-label')
      label.textContent = step.label || ''
      layer.append(packet, label)
      const started = performance.now()
      const move = (now) => {
        if (run !== generation) return
        const progress = Math.min(1, (now - started) / duration)
        const point = link.getPointAtLength((reverse ? 1 - progress : progress) * length)
        packet.setAttribute('cx', point.x)
        packet.setAttribute('cy', point.y)
        label.setAttribute('x', point.x + 10)
        label.setAttribute('y', point.y - 9)
        if (progress < 1) frame = requestAnimationFrame(move)
        else {
          packet.remove()
          label.remove()
          done()
        }
      }
      frame = requestAnimationFrame(move)
    }

    function show(next, advance) {
      clear()
      const run = ++generation
      index = (next + steps.length) % steps.length
      const step = steps[index]
      number.textContent = `${String(index + 1).padStart(2, '0')} / ${String(steps.length).padStart(2, '0')}`
      // Step text is authored in this page's own JSON, so it may hold markup such as <code>.
      text.innerHTML = step.text
      for (const id of [...(step.nodes || []), ...(step.states || [])]) svg.getElementById(id)?.classList.add('active')
      const links = (step.links || []).map((id) => svg.getElementById(id)).filter(Boolean)
      const finish = () => {
        if (run !== generation || !advance) return
        timer = setTimeout(() => playing && visible && show(index + 1, true), links.length ? HOLD : STILL)
      }
      const walk = (position) => {
        if (position >= links.length) return finish()
        travel(links[position], step, run, () => walk(position + 1))
      }
      if (links.length === 0) finish()
      else walk(0)
    }

    caption.addEventListener('click', (event) => {
      const action = event.target.closest('button')?.dataset.action
      if (!action) return
      if (action === 'toggle') {
        playing = !playing
        toggle.textContent = playing ? 'Pause' : 'Play'
        if (playing) show(index + 1, true)
        else clearTimeout(timer)
        return
      }
      playing = false
      toggle.textContent = 'Play'
      show(index + (action === 'next' ? 1 : -1), false)
    })

    new IntersectionObserver((entries) => {
      visible = entries.some((entry) => entry.isIntersecting)
      if (visible && playing) show(index + 1, true)
      if (!visible) clear()
    }, { threshold: 0.35 }).observe(figure)

    show(0, false)
  }

  // Marks the current page in the navigation.
  const page = location.pathname.split('/').pop() || 'index.html'
  document.querySelectorAll('nav a[href]').forEach((link) => {
    if (link.getAttribute('href') === page) link.setAttribute('aria-current', 'page')
  })

  document.querySelectorAll('figure.schematic').forEach(setup)
})()
