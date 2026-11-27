import { Window } from 'happy-dom'
import { describe, expect, it } from 'vitest'
import { CSS } from '../src/inspect/style.ts'

const css = CSS.replace(/\/\*[\s\S]*?\*\//g, '')

function declarations(rule: RegExp): Record<string, string> {
  const body = css.match(rule)?.[1]
  if (body === undefined) throw new Error(`Missing CSS rule: ${rule}`)
  return Object.fromEntries([...body.matchAll(/([\w-]+)\s*:\s*([^;]+)/g)].map(([, name, value]) => [name!, value!.trim()]))
}

// Each color is `light-dark(light, dark)`, or a `var()` of another token: one theme takes one side.
const root = declarations(/^\s*:root\s*\{([^{}]*)\}/m)
function themed(side: 0 | 1): Record<string, string> {
  const pick = (value: string) => value.replace(/light-dark\(\s*([^,()]+?)\s*,\s*([^,()]+?)\s*\)/g, (_, light: string, dark: string) => (side === 0 ? light : dark))
  const theme = Object.fromEntries(Object.entries(root).map(([name, value]) => [name, pick(value)]))
  const resolve = (value: string): string => value.replace(/var\((--[\w-]+)\)/g, (_, name: string) => resolve(theme[name] ?? ''))
  return Object.fromEntries(Object.entries(theme).map(([name, value]) => [name, resolve(value)]))
}
const light = themed(0)
const dark = themed(1)
const surfaces = ['bg', 'panel', 'rail', 'chrome', 'shade', 'shade-hover', 'selected']

type RGB = [number, number, number]

function rgb(hex: string | undefined, name = 'color'): RGB {
  if (!hex || !/^#[\da-f]{6}$/i.test(hex)) throw new Error(`Expected ${name} to be an opaque hex color, got ${hex}`)
  const value = Number.parseInt(hex.slice(1), 16)
  return [value >> 16, (value >> 8) & 0xff, value & 0xff]
}

const color = (theme: Record<string, string>, name: string) => rgb(theme[`--${name}`], `--${name}`)

/** WCAG relative luminance, with each sRGB channel linearized first. */
function luminance([r, g, b]: RGB): number {
  const linear = (channel: number) => {
    const s = channel / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
}

function contrast(a: RGB, b: RGB): number {
  const x = luminance(a)
  const y = luminance(b)
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

function hue([r, g, b]: RGB): number {
  const max = Math.max(r, g, b)
  const chroma = max - Math.min(r, g, b)
  if (chroma === 0) throw new Error('An achromatic color has no hue')
  const sector = max === r ? (g - b) / chroma : max === g ? (b - r) / chroma + 2 : (r - g) / chroma + 4
  return (sector * 60 + 360) % 360
}

const lightness = (channels: RGB) => (Math.max(...channels) + Math.min(...channels)) / (2 * 255)

describe.each([{ scheme: 'dark', theme: dark }, { scheme: 'light', theme: light }])('the inspector $scheme theme', ({ scheme, theme }) => {
  const checkContrast = (foreground: string, background: string, minimum: number) => {
    expect(contrast(color(theme, foreground), color(theme, background)), `--${foreground} on --${background}`).toBeGreaterThanOrEqual(minimum)
  }

  it('sets the browser color scheme when it is picked', () => {
    expect(declarations(new RegExp(`:root\\[data-theme='${scheme}'\\]\\s*\\{([^{}]*)\\}`))['color-scheme']).toBe(scheme)
  })

  it.each(['bright', 'dim', 'muted', 'faint', 'accent', 'red', 'warning'])('gives --%s text at least 4.5:1 contrast on every surface', (name) => {
    for (const surface of surfaces) checkContrast(name, surface, 4.5)
  })

  it('gives action button labels at least 4.5:1 contrast', () => {
    checkContrast('label', 'action', 4.5)
  })

  it.each(['gold', 'focus'])('gives --%s indicators at least 3:1 contrast on every surface', (name) => {
    for (const surface of surfaces) checkContrast(name, surface, 3)
  })

  it.each([
    ['red', 'warning', 15],
    ['red', 'accent', 15],
    ['warning', 'accent', 15],
  ] as const)('keeps --%s and --%s hues at least %s degrees apart', (first, second, minimum) => {
    const gap = Math.abs(hue(color(theme, first)) - hue(color(theme, second)))
    expect(Math.min(gap, 360 - gap)).toBeGreaterThanOrEqual(minimum)
  })
})

it('draws the dark theme in red ink on near-black', () => {
  const [r, g, b] = color(dark, 'ink')
  expect(r - Math.max(g, b)).toBeGreaterThanOrEqual(0x40)
  expect(lightness(color(dark, 'bg'))).toBeLessThan(0.06)
})

it('draws the light theme in blue ink on cream', () => {
  const [r, g, b] = color(light, 'ink')
  expect(b - Math.max(r, g)).toBeGreaterThanOrEqual(0x40)
  const [br, bg, bb] = color(light, 'bg')
  expect(br).toBeGreaterThanOrEqual(bg)
  expect(bg).toBeGreaterThanOrEqual(bb)
  expect(bb).toBeGreaterThan(0xe8)
})

it('draws hairlines below headers, not around the shell, pane, or task prerequisites', async () => {
  const window = new Window({ width: 1280, height: 900 })
  try {
    window.document.head.innerHTML = `<style>${CSS}</style>`
    window.document.body.innerHTML = `
      <div class="shell">
        <nav class="sidebar"><div class="brand">Politburo</div></nav>
        <main class="main">
          <header class="header">Handoffs</header>
          <section class="home-queue"><h2>Runnable</h2><div class="handoff-needs">Requires review</div></section>
        </main>
        <aside class="pane"><header class="header">Thread</header></aside>
      </div>
    `
    const style = (selector: string) => window.getComputedStyle(window.document.querySelector(selector)!)
    // happy-dom resolves no `light-dark()` color, so a rule in one reads from the stylesheet.
    expect(declarations(/\.home-queue h2\s*\{([^{}]*)\}/)['border-bottom']).toMatch(/solid/)
    // A header's rule is drawn by hand, on a layer of its own so its wobble moves nothing it holds.
    for (const selector of ['.brand', '.header']) expect(style(selector).position, selector).toBe('relative')
    expect(declarations(/\.header, \.tabs:not\(\.plain\), \.ops-card\)::after\s*\{([^{}]*)\}/)['border-bottom']).toMatch(/solid/)
    expect(style('.shell').borderTopStyle).not.toBe('solid')
    expect(style('.sidebar').borderRightStyle).not.toBe('solid')
    expect(style('.pane').borderLeftStyle).not.toBe('solid')
    expect(style('.handoff-needs').getPropertyValue('border-inline-start')).not.toContain('solid')
  } finally {
    await window.happyDOM.close()
  }
})

it('keeps the home emblem image transparent', () => {
  const emblem = declarations(/^\s*\.home-emblem\s+img\s*\{([^{}]*)\}/m)
  expect(Object.keys(emblem).filter((property) => /^background(?:-|$)/i.test(property))).toEqual([])
})
