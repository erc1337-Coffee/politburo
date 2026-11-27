import type { ProfileOption } from '../client/client.ts'
import { VERSION } from '../version.ts'
import { CSS } from './style.ts'
import { THEME_BOOT, THEME_BOOT_HASH } from './theme.ts'

// What every inspector serves alike, on this machine (`server.ts`) or in your app (`handler.ts`):
// the page's HTML, its policy, and which proxied paths it refuses.

const attribute = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)

/**
 * The page, with what only it is told: its credential for the proxy, the profile it starts as, and
 * the path it's served under (`''` at a server's root), which its bundle, its proxy, and its links
 * are under too.
 */
export const shell = ({ token, profile, base, named = false }: { token: string; profile: ProfileOption; base: string; named?: boolean }) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="inspect-token" content="${attribute(token)}">
<meta name="inspect-profile" content="${attribute(JSON.stringify(profile))}">
<meta name="inspect-base" content="${attribute(base)}">
${named ? '<meta name="inspect-named" content="1">\n' : ''}<title>board</title>
<script>${THEME_BOOT}</script>
<style>${CSS}</style>
</head>
<body>
${SHADERS}
<div id="root"></div>
<script type="module" src="${attribute(base)}/app.js?v=${attribute(VERSION)}"></script>
</body>
</html>`

/**
 * The page's SVG filters, which the stylesheet picks by theme (`--tint`, `--boil`): a duotone over
 * the whole page, one for each theme, and a hand-drawn wobble on its rules, still when you'd rather
 * not see motion.
 */
export const SHADERS = `<svg class="shaders" aria-hidden="true" focusable="false"><defs>
<filter id="tint-light" color-interpolation-filters="sRGB">
<feColorMatrix type="saturate" values="0"/>
<feComponentTransfer result="duo"><feFuncR type="table" tableValues="0.094 1"/><feFuncG type="table" tableValues="0.094 0.992"/><feFuncB type="table" tableValues="0.427 0.973"/></feComponentTransfer>
<feComposite in="duo" in2="SourceGraphic" operator="arithmetic" k2="0.7" k3="0.3"/>
</filter>
<filter id="tint-dark" color-interpolation-filters="sRGB">
<feColorMatrix type="saturate" values="0"/>
<feComponentTransfer result="duo"><feFuncR type="table" tableValues="0.04 0.88"/><feFuncG type="table" tableValues="0.04 0.27"/><feFuncB type="table" tableValues="0.04 0.12"/></feComponentTransfer>
<feComposite in="duo" in2="SourceGraphic" operator="arithmetic" k2="0.4" k3="0.6"/>
</filter>
${boil('boil', '<animate attributeName="seed" values="1;2;3;4;5;6;7;8" dur="1s" calcMode="discrete" repeatCount="indefinite"/>')}
${boil('boil-still', '')}
</defs></svg>`

function boil(id: string, motion: string) {
  return `<filter id="${id}" x="-5%" y="-5%" width="110%" height="110%">
<feTurbulence type="turbulence" baseFrequency="0.03" numOctaves="2" seed="1" result="noise">${motion}</feTurbulence>
<feDisplacementMap in="SourceGraphic" in2="noise" scale="2.5" xChannelSelector="R" yChannelSelector="G"/>
</filter>`
}

export const CSP = [
  "default-src 'none'",
  // Attachments arrive as `blob:` URLs: the page fetches them through the proxy, with its token.
  "img-src 'self' data: blob:",
  'media-src blob:',
  "style-src 'unsafe-inline'",
  // The bundle, and the one inline script that applies your theme before the page paints.
  `script-src 'self' '${THEME_BOOT_HASH}'`,
  "connect-src 'self'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ')

/** Whether a proxied path, as sent, climbs out of the board's API: `..`, `.`, or a backslash, encoded or not. */
export function relative(path: string): boolean {
  let decoded: string
  try {
    decoded = decodeURIComponent(path)
  } catch {
    return true
  }
  return /(^|\/)\.\.?(\/|$)|\\/.test(decoded)
}
