/**
 * The inspector's ink-on-paper themes: blue ink on cream, or red ink on near-black. Each color is
 * `light-dark(light, dark)`; the page follows the system until you pick a theme (`theme.ts`), which
 * sets `data-theme` on the root.
 */
export const CSS = `
:root {
  color-scheme: light dark;
  --bg: light-dark(#fffdf7, #0b0b0e);
  --panel: light-dark(#fffdf7, #140e0f);
  --rail: light-dark(#f5f5f5, #121218);
  --chrome: light-dark(#f5f5f5, #121218);
  --chrome-pressed: light-dark(#e6e5e9, #0b0b0e);
  /* The ink rules and frames are drawn in; text takes the steps below, each readable on every surface
     once the page's duotone has tinted both (inspect-theme.test.ts checks). */
  --ink: light-dark(#2c3382, #af5353);
  --bright: light-dark(#1f2566, #f0f0f0);
  --dim: light-dark(#2c3382, #e6e0e0);
  --muted: light-dark(#454b91, #cbbfbf);
  --faint: light-dark(#4c4f60, #c9bdbd);
  --hairline: light-dark(#2c338240, #af535359);
  /* A rule drawn by hand: thick enough that its wobble never breaks it. */
  --rule: light-dark(#2c338273, #af53538c);
  /* Ink over the panel, solid so text contrast holds on it. */
  --shade: light-dark(#f2f1f0, #241516);
  --shade-hover: light-dark(#e6e5e9, #301a1b);
  --selected: light-dark(#dddde4, #3c2021);
  --accent: light-dark(#2c3382, #f59a9a);
  --gold: var(--accent);
  --gold-text: light-dark(#fffdf7, #ffffff);
  --focus: var(--accent);
  --accent-transparent: light-dark(#2c338233, #af535340);
  --scrim: light-dark(#1f256680, #0b0b0eb3);
  --label: light-dark(#fffdf7, #ffffff);
  --action: light-dark(#2c3382, #9c4646);
  --action-hover: light-dark(#3a42a3, #af5353);
  --action-pressed: light-dark(#222868, #7f3838);
  --bevel-light: light-dark(#ffffff, #2a1c1d);
  --bevel-dark: light-dark(#c9cadb, #000000);
  --raised: 0 1px 1px light-dark(#1f25661a, #0006);
  --shadow: light-dark(#1f256626, #0009);
  --red: light-dark(#a3231d, #ff9ee6);
  --warning: light-dark(#604810, #ffa45c);
  /* The page's duotone, and the wobble its rules take; \`shell.ts\` holds the filters. */
  --tint: url(#tint-light);
  --boil: url(#boil);
  --display: 'Avenir Next Condensed', 'Bahnschrift', 'Arial Narrow', 'Liberation Sans Narrow', 'Helvetica Neue', sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, monospace;
  --metadata: .75rem/1rem var(--mono);
  --inset: 12px;
  --overlay-layer: 30;
  --nav-layer: 41;
}
:root[data-theme='light'] { color-scheme: light; }
:root[data-theme='dark'] { color-scheme: dark; --tint: url(#tint-dark); }
@media (prefers-color-scheme: dark) { :root:not([data-theme]) { --tint: url(#tint-dark); } }
@media (prefers-reduced-motion: reduce) { :root { --boil: url(#boil-still); } }
.shaders { position: absolute; width: 0; height: 0; overflow: hidden; }
* { box-sizing: border-box; }
html { scroll-behavior: auto; -webkit-tap-highlight-color: var(--accent-transparent); }
body {
  margin: 0;
  overflow: hidden;
  background: var(--bg);
  color: var(--dim);
  font: .875rem/1.25rem system-ui, sans-serif;
  font-variant-numeric: tabular-nums;
  cursor: default;
  filter: var(--tint);
}
/* Rules drawn by hand: a header's hairline and a card's frame wobble, on a layer of their own so
   what they hold stays still and sharp. */
:is(.brand, .header, .tabs:not(.plain), .ops-card) { position: relative; }
:is(.brand, .header, .tabs:not(.plain), .ops-card)::after {
  content: ''; position: absolute; inset: 0; border-bottom: 2px solid var(--rule); border-radius: inherit;
  filter: var(--boil); pointer-events: none;
}
.ops-card::after { border: 2px solid var(--rule); }
a { color: inherit; text-decoration: none; cursor: default; }
button { cursor: default; font: inherit; color: inherit; background: none; border: 0; padding: 0; letter-spacing: inherit; }
input, textarea { font: inherit; color: var(--bright); letter-spacing: inherit; }
input, select { cursor: default; }
input:not([type]), input[type='text'], input[type='search'], input[type='email'], input[type='url'],
input[type='tel'], input[type='password'], input[type='number'], input[type='datetime-local'],
textarea, [contenteditable]:not([contenteditable='false']) { cursor: text; }
::selection { background: var(--accent-transparent); }
:is(a, button, input, textarea, select, [tabindex]):focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
.shell [data-view-title]:focus { outline: 2px solid var(--focus); outline-offset: 2px; }
:where(code, pre, .avatar) { font-family: var(--mono); }

.boot { display: grid; place-items: center; height: 100dvh; color: var(--faint); }
.boot.error, .error { color: var(--red); }
.name-gate { display: grid; gap: 10px; width: min(320px, 90vw); color: var(--bright); }
.name-gate p { margin: 0; color: var(--faint); }
.name-gate input { width: 100%; height: 36px; padding: 0 10px; border: 0; background: var(--shade); font-size: 16px; }
.name-gate .send { justify-self: end; }
.empty, .error { padding: 20px; margin: 0; color: var(--faint); }
.faint { color: var(--faint); }
.grow { flex: 1; min-width: 0; }
.hint { color: var(--faint); font-size: 11px; }

.shell { display: flex; flex-direction: column; height: 100dvh; overflow: hidden; }
/* The columns share the header and body tracks, with a full-width pause row between them. */
.workspace { --header-height: 46px; display: grid; grid-template: var(--header-height) auto minmax(0, 1fr) / minmax(0, 1fr); flex: 1; min-height: 0; }
.pause-banner { grid-area: 2 / 1 / 3 / -1; z-index: calc(var(--nav-layer) + 1); max-height: 6em; overflow-y: auto; padding: 6px var(--inset); background: var(--selected); color: var(--bright); overflow-wrap: anywhere; }
:is(.sidebar, .main, .pane) { position: relative; grid-area: 1 / 1 / -1 / 2; grid-template-rows: subgrid; min-width: 0; min-height: 0; }
:is(.sidebar, .main, .pane) > :is(.brand, .header) { grid-row: 1; }
:is(.sidebar, .main, .pane) > :is(.view-body, .page) { grid-row: 3; }
.view-body { display: flex; flex-direction: column; min-height: 0; }
@media (min-width: 64rem) {
  .shell { margin: 12px; height: calc(100dvh - 24px); border-radius: 7px; box-shadow: 0 2px 3px var(--shadow); }
}

/* --- sidebar: an opaque navigation rail --- */
/* One column as wide as the rail, never its widest row: a long channel name truncates instead. */
.sidebar { display: none; grid-template-columns: minmax(0, 1fr); background: var(--rail); }
/* What's said on the board scrolls; its settings and who you are stay put under it. */
.sidebar-scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 8px 8px 12px; }
.sidebar-foot { flex-shrink: 0; padding: 4px 8px 12px; }
.brand {
  height: var(--header-height);
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 var(--inset);
  background: var(--chrome);
  color: var(--bright);
  font-weight: 600;
  gap: 8px;
}
/* Which board this is: its name, and where it is under it. */
.brand .which { display: grid; min-width: 0; line-height: 1.3; }
.home-emblem { flex: none; width: 44px; height: 44px; display: grid; place-items: center; border-radius: 4px; }
/* The emblem is transparent. */
.home-emblem img { display: block; object-fit: contain; }
.home-emblem:hover { background: var(--shade-hover); }
.home-emblem:focus-visible { outline-offset: -2px; }
.brand .name, .brand .at { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.brand .at { color: var(--faint); font-size: 11px; font-weight: 400; }
.sidebar h2 { display: flex; align-items: center; justify-content: space-between; height: 18px; margin: 16px 8px 4px; font-size: 11px; font-weight: 500; color: var(--faint); }
.sidebar h2 .tool { min-width: 20px; height: 20px; padding: 0; color: var(--faint); }
.sidebar h2 .tool:last-child { margin-right: -6px; }
.sidebar h2 .tool + .tool { margin-left: 4px; }
.sidebar h2 .tool:not(:disabled, [aria-disabled='true']):is(*, :hover, :active, [aria-pressed='true'], [data-popup-open]) {
  background: none; box-shadow: none; border: 0; transform: none;
}
.sidebar h2 .tool:not(:disabled, [aria-disabled='true']):hover { color: var(--bright); }
.sidebar .item.settings { gap: 8px; color: var(--faint); font-size: 12px; }
.sidebar .item.settings:hover, .sidebar .item.settings[aria-current='page'] { color: var(--bright); }
/* Dark mode, as a box the ink fills. */
.sidebar .item.theme-toggle { gap: 8px; color: var(--faint); font-size: 12px; }
.sidebar .item.theme-toggle:hover { color: var(--bright); }
.theme-toggle input {
  appearance: none; display: grid; place-content: center; width: 14px; height: 14px; margin: 0 0 0 0;
  border: 2px solid var(--accent); border-radius: 2px; background: none;
}
.theme-toggle input::before { content: ''; width: 6px; height: 6px; background: var(--accent); transform: scale(0); }
.theme-toggle input:checked::before { transform: scale(1); }
.new-channel { display: flex; align-items: center; gap: 2px; margin: 2px 0 4px; }
.new-channel input { flex: 1; min-width: 0; height: 28px; padding: 0 8px; border: 0; background: var(--shade); font-size: 12px; }
.sidebar .item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  min-height: 30px;
  color: var(--muted);
  font-size: .875rem;
  border-radius: 4px;
}
.sidebar .item:hover { background: var(--shade-hover); color: var(--bright); }
.sidebar .item[aria-current='page'] { background: var(--selected); color: var(--accent); font-weight: 700; }
.sidebar .item .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sidebar .item.unread { color: var(--bright); font-weight: 600; }
.sidebar .count { color: var(--faint); font-size: 11px; font-weight: 400; }
.sidebar h2 .spacer { flex: 1; }
.sidebar .item .eye, .sidebar .item .gear { display: none; color: var(--faint); }
.sidebar .item:hover .eye, .sidebar .item:hover .gear { display: inline-flex; }
.sidebar .item .eye:hover, .sidebar .item .gear:hover { color: var(--bright); }
.sidebar .item.hidden-channel { opacity: .55; }
.sidebar .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); }
.whoami { display: flex; align-items: center; gap: 6px; padding: 6px 8px; color: var(--muted); font-size: 11px; }
.whoami .as { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.developer-identity { margin-bottom: 12px; color: var(--muted); }
.identities { display: grid; gap: 14px; max-width: 760px; padding: 6px 0; }
.identity { display: grid; grid-template-columns: 40px minmax(0, 1fr); gap: 12px; align-items: start; }
.identity-body { display: grid; gap: 6px; min-width: 0; }
.identity-label { color: var(--bright); font-weight: 600; font-size: 13px; }
.identity-label .faint { font-weight: 400; font-size: 12px; }
.identity-fields { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.identity-fields input:not([type]) { width: 220px; height: 26px; padding: 0 8px; border: 0; background: var(--shade); font-size: 12px; }
.avatar > img { width: 100%; height: 100%; object-fit: cover; }
.chip .faces { display: inline-flex; vertical-align: middle; }
.chip .faces .avatar + .avatar { margin-left: -4px; }
.message.turn-user .meta-line, .message.turn-agent .meta-line { align-items: center; }
.profile-options { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 6px 0; }
.choice { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.choice svg { color: var(--accent); }

/* --- resize handles: show the grip only on interaction --- */
.resize { position: absolute; top: 0; bottom: 0; width: 7px; z-index: 5; display: flex; justify-content: center; outline: none; }
.resize.right { right: -3px; }
.resize.left { left: -3px; }
.resize i { width: 2px; height: 100%; }
.resize:hover i { background: var(--muted); }
.resize.dragging i { background: var(--accent); }
.resize:focus-visible i { background: var(--focus); }

/* --- main and the thread pane --- */
.main, .pane { display: grid; }
.main { background: var(--panel); }
.pane { background: var(--bg); z-index: var(--overlay-layer); }
.resize { display: none; }
@media (min-width: 64rem) {
  .workspace { grid-template-columns: auto minmax(0, 1fr) auto; }
  .sidebar:not([hidden]) { display: grid; }
  .main { grid-column: 2; }
  .pane { grid-column: 3; width: min(var(--pane-width), max(320px, calc(100vw - 24px - var(--sidebar-width) - 20rem))); }
  .resize { display: flex; }
}

.header {
  height: var(--header-height);
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 var(--inset);
  white-space: nowrap;
}
.header { background: var(--chrome); }
.header > .tool:hover, .brand > .tool:hover { background: var(--shade); }
.header .title {
  margin: 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; color: var(--bright);
  font: 700 1.125rem/1.375rem var(--display);
  font-stretch: condensed;
  letter-spacing: .06em;
  text-transform: uppercase;
}
.header .meta { color: var(--faint); font-size: 11px; overflow: hidden; text-overflow: ellipsis; }
.header .spacer { flex: 1; }
.header.flat { border-bottom: 0; }

/* --- tabs: plain text, the current one underlined. Under a flat header they carry its hairline. --- */
.tabs { flex-shrink: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 0 18px; min-height: 34px; padding: 0 20px; }
.tabs.plain { padding-top: 4px; }
.tab { padding: 7px 0; margin-bottom: -1px; border-bottom: 1px solid transparent; color: var(--muted); white-space: nowrap; cursor: default; }
.tab:hover { color: var(--bright); }
.tab[aria-current='page'] { border-bottom: 2px solid var(--accent); color: var(--accent); font-weight: 600; }
.tab-actions { display: flex; align-items: center; gap: 14px; margin-left: auto; }
.tab-actions .act { height: 24px; }
.text-link { color: var(--accent); text-decoration: underline; text-decoration-color: var(--faint); text-underline-offset: 3px; white-space: nowrap; cursor: default; }
.text-link:hover { text-decoration-color: currentColor; }
.scrim { display: none; }

.live { display: flex; align-items: center; gap: 6px; color: var(--faint); font-size: 11px; }
.live i { width: 6px; height: 6px; border-radius: 50%; background: var(--faint); }
.live:not(.connecting, .reconnecting) i { background: var(--accent); }

/* --- the feed: no row borders; a short conversation sits on the composer --- */
.feed-wrap { position: relative; flex: 1; min-height: 0; display: flex; }
.feed { flex: 1; overflow-y: auto; padding: 8px 0 12px; display: flex; flex-direction: column; overflow-anchor: none; }
.feed > div { margin-top: auto; }
.jump {
  position: absolute;
  bottom: 12px;
  left: 50%;
  transform: translateX(-50%);
  padding: 3px 10px;
  background: var(--bg);
  color: var(--accent);
  font-size: 11px;
}
.divider { display: flex; align-items: center; gap: 8px; margin: 14px 20px 4px; color: var(--faint); font-size: 11px; }

.message { position: relative; display: grid; grid-template-columns: 40px minmax(0, 1fr); gap: 8px; padding: 4px var(--inset) 4px 8px; }
.message.continued { padding-block: 0; }
@media (hover: hover) { .message:not(.active):hover { background: var(--shade); } }
.message.active { background: var(--selected); box-shadow: inset 2px 0 var(--gold); }
.pane .feed-wrap { background: var(--panel); }
.pane .task-card, .pane .thread-facts { background: var(--rail); }
.message.pending { opacity: 0.5; }
.message.failed { opacity: 1; }
.gutter { display: flex; justify-content: center; align-items: flex-start; }
.gutter-time { visibility: hidden; color: var(--faint); font-size: 10px; line-height: 21px; }
.message.active .gutter-time, .gutter-time.shown { visibility: visible; }
.avatar {
  flex-shrink: 0;
  display: inline-grid;
  place-items: center;
  border-radius: 50%;
  background: var(--selected);
  color: var(--accent);
  font-weight: 600;
  overflow: hidden;
}
.body { min-width: 0; }
.meta-line { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; }
.author { color: var(--bright); font-weight: 600; }
.where { color: var(--faint); font-size: 12px; }
.where a { color: var(--accent); cursor: default; }
.where a:hover { text-decoration: underline; }
.time, .id { color: var(--faint); font-size: 11px; }
/* Message text is markdown. Blocks stay compact; a short message reads as one line. */
.text { max-inline-size: 65ch; overflow-wrap: anywhere; color: var(--dim); font-size: .875rem; line-height: 1.25rem; }
.text > :first-child { margin-top: 0; }
.text > :last-child { margin-bottom: 0; }
.text > p:last-child, .text > p:has(+ .edited) { display: inline; }
.text p { margin: 0 0 6px; }
.text a { color: var(--accent); text-decoration: underline; text-decoration-color: var(--faint); text-underline-offset: 3px; overflow-wrap: anywhere; }
.text a:hover { text-decoration-color: currentColor; }
.text strong { color: var(--bright); font-weight: 600; }
.text h1, .text h2, .text h3, .text h4 { margin: 8px 0 4px; color: var(--bright); font-size: 14px; font-weight: 600; }
.text ul, .text ol { margin: 2px 0 6px; padding-left: 20px; }
.text li + li { margin-top: 1px; }
.text blockquote { margin: 4px 0; padding-left: 10px; color: var(--muted); }
.text code { padding: 1px 4px; border-radius: 3px; background: var(--shade); color: var(--bright); font-size: 0.92em; }
.message.active .text code { background: var(--shade-hover); }
.text pre { margin: 4px 0 6px; padding: 10px; overflow-x: auto; border-radius: 4px; background: var(--shade); line-height: 1.5; }
.text pre code, .message.active .text pre code { padding: 0; border-radius: 0; background: none; font-size: 13px; }
.text table { margin: 4px 0 6px; border-collapse: collapse; font-size: 12px; display: block; overflow-x: auto; max-width: 100%; }
.text th, .text td { padding: 3px 10px; text-align: left; white-space: nowrap; }
.text th { color: var(--bright); font-weight: 600; background: var(--shade); }
.text hr { border: 0; margin: 12px 0; }
.text input[type='checkbox'] { margin: 0 6px 0 0; vertical-align: middle; }
.text ul.contains-task-list { list-style: none; padding-left: 2px; }
.avatar-wrap { position: relative; display: inline-flex; }
.source {
  position: absolute;
  right: -5px;
  bottom: -5px;
  width: 16px;
  height: 16px;
  padding: 2px;
  border-radius: 4px;
  background: var(--bg);
  color: var(--bright);
}
.source svg { display: block; width: 100%; height: 100%; }
.source.text { display: grid; place-items: center; font-size: 9px; font-weight: 600; }
.mention { color: var(--accent); font-weight: 600; }
.removed { color: var(--faint); font-style: italic; }
.edited { color: var(--faint); font-size: 11px; }
.undelivered { margin-top: 4px; font-size: 11px; color: var(--red); }
.undelivered button { text-decoration: underline; }

.chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
.badge, .label, .chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 7px;
  background: var(--shade);
  color: var(--muted);
  font-size: 11px;
  line-height: 16px;
}
.badge.github { color: var(--accent); }
.label:hover, .chip:hover { color: var(--bright); background: var(--shade-hover); }
.label button { color: var(--faint); display: inline-flex; }
.label button:hover { color: var(--bright); }
/* Your own reaction: a little brighter, not louder. */
.chip.mine { background: var(--shade-hover); color: var(--bright); }
/* Attachments: media in a fixed frame, so loading never moves the page; files as chips. */
.links { display: flex; flex-direction: column; gap: 6px; margin-top: 6px; }
.link-embed { padding: 2px 0 2px 10px; }
.link-meta { display: flex; gap: 8px; align-items: baseline; font-size: 12px; color: var(--muted); }
.link-meta .author { font-size: 13px; }
.link-meta a, .link-file a { color: var(--accent); text-decoration: underline; text-decoration-color: var(--faint); text-underline-offset: 3px; overflow-wrap: anywhere; }
.link-meta a:hover, .link-file a:hover { text-decoration-color: currentColor; }
.link-file { display: flex; gap: 4px; align-items: center; margin-top: 2px; font-size: 12px; color: var(--muted); }
.attachments { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.attachment-media { display: block; width: 320px; max-width: 100%; height: 200px; background: var(--shade); overflow: hidden; }
.attachment-media img, .attachment-media video { display: block; width: 100%; height: 100%; object-fit: contain; }
.file { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; padding: 4px 8px; background: var(--shade); color: var(--dim); font-size: 12px; }
button.file:hover { background: var(--shade-hover); color: var(--bright); }
.file-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file button { color: var(--faint); display: inline-flex; }
.file button:hover { color: var(--bright); }
.composer-files { margin: 0 12px 4px; }
.replies { display: inline-flex; align-items: center; gap: 6px; margin: 4px 0 0 -4px; padding: 2px 6px 2px 4px; color: var(--dim); font-size: 12px; font-weight: 600; }
.replies:hover { background: var(--shade-hover); color: var(--bright); }
.replies .time { font-weight: 400; }
.replies .faces { display: inline-flex; }
.replies .faces .avatar + .avatar { margin-left: -4px; }

.editor { display: grid; gap: 2px; margin: 2px 0; }
.editor textarea {
  width: 100%;
  padding: 8px 10px;
  border: 0;
  background: var(--bg);
  resize: none;
  font-size: 14px;
}

/* --- hover actions at the row's corner --- */
.actions { position: absolute; top: -12px; right: 20px; z-index: 5; display: flex; border-radius: 4px; background: var(--chrome); box-shadow: var(--raised); }
.tool {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  min-width: 28px;
  height: 26px;
  padding: 0 6px;
  color: var(--muted);
  font-size: 13px;
}
.tool:hover, .tool[data-popup-open] { color: var(--bright); }
.tool.on { color: var(--accent); }
.tool .count, .tool .tool-label { font-size: 11px; }

/* --- menus and popovers --- */
.positioner { z-index: 50; outline: none; }
.frame { position: relative; isolation: isolate; }
.dots {
  position: absolute;
  inset: 0;
  border-radius: 6px;
  z-index: -1;
  box-shadow: 0 4px 12px var(--shadow);
  pointer-events: none;
}
.menu { min-width: 172px; padding: 6px; border-radius: 6px; background: var(--panel); outline: none; }
.menu.list { max-height: 260px; overflow-y: auto; }
.item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  color: var(--muted);
  outline: none;
  cursor: default;
  white-space: nowrap;
}
.item[data-highlighted] { background: var(--shade); color: var(--bright); }
.item.danger, .item.danger[data-highlighted] { color: var(--red); }
/* A hint (a message's ID) gives way first: a long one ends in an ellipsis, not a wide menu. */
.item .hint { margin-left: 12px; min-width: 0; max-width: 22ch; overflow: hidden; text-overflow: ellipsis; }
.separator { height: 6px; }
.empty-item { padding: 6px 8px; color: var(--faint); }
.emoji-row { display: grid; grid-template-columns: repeat(6, 1fr); }
.item.emoji { justify-content: center; padding: 6px 0; font-size: 15px; }
.emoji-grid { display: grid; grid-template-columns: repeat(12, 30px); padding: 6px; }
.emoji-grid .emoji { height: 30px; font-size: 16px; }
.emoji-grid .emoji:hover { background: var(--shade); }
.popover { width: min(380px, calc(100vw - 32px)); padding: 12px; }
.popover-title { margin: 0 0 8px; color: var(--bright); font-size: 12px; font-weight: 600; }

.labels-editor { display: grid; gap: 10px; }
.labels-editor > .hint { margin: 0; }
.label-rows { display: grid; }
.label-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr) auto; align-items: center; gap: 8px; padding: 2px 0 2px 8px; }
.label-row:hover { background: var(--shade); }
.label-key { color: var(--bright); overflow: hidden; text-overflow: ellipsis; }
.label-value { color: var(--muted); overflow: hidden; text-overflow: ellipsis; }
.label-add { display: flex; align-items: center; gap: 6px; }
.suggest { display: flex; align-items: center; min-width: 0; padding: 0 8px; background: var(--shade); }
.suggest input { width: 100%; min-width: 0; height: 28px; border: 0; outline: none; background: none; }
.suggest:focus-within { outline: 1px solid var(--focus); }
.suggest .prefix { color: var(--faint); }
.suggest input::placeholder { color: var(--faint); }
.label-add > .suggest { width: 38%; }

/* --- filters --- */
.filter-bar { flex-shrink: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 8px 20px 0; }
.clear { color: var(--faint); font-size: 11px; }
.clear:hover { color: var(--bright); }
.filter-form { display: grid; gap: 12px; }
.filter-form > .clear { justify-self: start; }
.filter-row { display: grid; grid-template-columns: 52px minmax(0, 1fr); align-items: start; gap: 10px; }
.filter-name { color: var(--faint); font-size: 11px; line-height: 28px; }
.filter-row .grow { display: grid; gap: 6px; }
.segments { display: flex; flex-wrap: wrap; gap: 2px; }
.segment { height: 28px; padding: 0 10px; background: var(--shade); color: var(--muted); }
.segment:hover { color: var(--bright); }
.segment.on { background: var(--bright); color: var(--bg); }

/* --- composer: recessed input on a separate toolbar surface --- */
.composer { flex-shrink: 0; padding: 8px; background: var(--rail); }
.composer-box {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.composer-box textarea {
  width: 100%;
  min-height: 38px;
  max-height: clamp(38px, 24dvh, 160px);
  padding: 8px;
  border: 0;
  border-radius: 6px;
  background: var(--panel);
  box-shadow: inset 0 1px 3px var(--shadow);
  color: var(--dim);
  font-size: 14px;
  line-height: 1.5;
  resize: none;
  overflow-y: auto;
}
.composer-box textarea::placeholder { color: var(--faint); }
.composer-channel { margin: 8px 8px 0; align-self: flex-start; width: min(320px, calc(100% - 16px)); }
.composer-labels { margin: 8px 12px 0; }
.composer-footer { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; min-height: 30px; }
.composer-footer .hint { margin-left: auto; margin-right: 8px; }
.pane .composer-footer .hint { display: none; }
.pane .composer-footer .send { margin-left: auto; }
.send { height: 30px; padding: 0 12px; font-weight: 600; white-space: nowrap; }
.button-sounds { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; white-space: nowrap; }
.button-sounds input { accent-color: var(--action); }
.send.small { height: 28px; padding: 0 10px; }
.send:disabled { opacity: 0.5; }

/* --- a view that isn't a feed: rows under a header --- */
.page { flex: 1; min-height: 0; overflow-y: auto; padding: 8px 0 16px; }
.home-view { padding: clamp(16px, 4vw, 40px); }
.home-view > * { max-width: 52rem; margin-inline: auto; }
.home-view p { margin: 0 0 6px; color: var(--muted); }
.home-view a { color: var(--accent); text-decoration: underline; text-underline-offset: 3px; }
.home-view a:focus-visible, .home-view button:focus-visible { outline: 2px solid var(--focus); outline-offset: 3px; }
.home-queue h2 { margin: 0; padding-bottom: 2px; border-bottom: 1px solid var(--hairline); font-size: 1rem; color: var(--bright); }
.needs-view { padding-block: 8px 12px; }
.needs-view section + section, .needs-view p.error { margin-block-start: 12px; }
.needs-view ul { list-style: none; margin: 0; padding: 0; }
.needs-view li { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0 8px; padding-block: 3px; overflow-wrap: anywhere; }
.needs-view small { color: var(--muted); }
.more { display: block; margin: 8px 20px; }
/* A few facts, each a quiet name and what it is. */
.facts { display: grid; grid-template-columns: 44px minmax(0, 1fr); gap: 3px 10px; margin: 0; }
.facts dt { color: var(--faint); font-size: 11px; line-height: 18px; }
.facts dd { margin: 0; color: var(--dim); overflow-wrap: anywhere; }

/* --- buttons that act, and the small forms that ask first --- */
.acts { display: flex; flex-wrap: wrap; gap: 4px; }
.acts .act[aria-haspopup] { padding: 0 7px; }
.act { display: inline-flex; align-items: center; gap: 5px; height: 26px; padding: 0 9px; color: var(--dim); font-size: 12px; white-space: nowrap; }
.act:hover, .act[data-popup-open] { color: var(--bright); }
.act.danger { color: var(--red); }
/* A row's own control: there when you're on the row, and it says what it is only when you reach for it. */
.act.quiet { visibility: hidden; color: var(--muted); }
:hover > .act.quiet, :focus-within > .act.quiet { visibility: visible; }
.act.quiet:hover, .act.quiet:focus-visible { color: var(--red); }
.act:disabled { opacity: 0.5; }

/* One raised surface for action buttons. Plain buttons use inset edges without adding height. */
:is(.tab-actions, .home-view) button:not(.send, .act, .tool) { padding-inline: 8px; }
/* Match the standalone header control's specificity as well. */
:is(.send, .act, .tool, .tab-actions button, .home-view button, .header > .tool) {
  --button-fill: var(--chrome);
  --button-hover: var(--shade-hover);
  --button-pressed: var(--chrome-pressed);
  --button-light: var(--bevel-light);
  --button-dark: var(--bevel-dark);
  background: var(--button-fill);
  border-radius: 4px;
  box-shadow: inset 1px 1px var(--button-light), inset -1px -1px var(--button-dark), var(--raised);
  transition: none;
}
:is(.send, .act.primary) {
  --button-fill: var(--action);
  --button-hover: var(--action-hover);
  --button-pressed: var(--action-pressed);
  --button-light: var(--gold-text);
  --button-dark: var(--bevel-dark);
  color: var(--label);
}
:is(.act, .tool)[data-popup-open] { background: var(--button-hover); }
@media (hover: hover) {
  :is(.send, .act, .tool, .tab-actions button, .home-view button, .header > .tool):not(:disabled, [aria-disabled='true']):hover {
    background: var(--button-hover);
  }
}
:is(.send, .act, .tool, .tab-actions button, .home-view button, .header > .tool):not(:disabled, [aria-disabled='true']):is(:active, [aria-pressed='true']) {
  background: var(--button-pressed);
  box-shadow: inset 1px 1px var(--button-dark), inset -1px -1px var(--button-light);
  transform: translate(1px, 1px);
}
@media (prefers-reduced-motion: reduce) {
  button, .send, .act, .tool { transition: none; animation: none; }
  :is(.send, .act, .tool, .tab-actions button, .home-view button, .header > .tool):not(:disabled, [aria-disabled='true']):is(:active, [aria-pressed='true']) {
    transform: none;
  }
}

.ask { display: grid; gap: 8px; }
.dialog-backdrop { position: fixed; inset: 0; z-index: var(--nav-layer); background: var(--scrim); }
.dialog {
  position: fixed; top: 50%; left: 50%; z-index: var(--nav-layer); transform: translate(-50%, -50%);
  width: min(460px, calc(100vw - 32px)); max-height: calc(100dvh - 32px); overflow-y: auto;
  padding: 12px 14px 14px; border-radius: 6px; background: var(--panel); box-shadow: 0 8px 28px var(--shadow); outline: none;
}
.dialog-head { display: flex; align-items: center; justify-content: space-between; }
.dialog-head .popover-title { margin: 0; }
.channel-form { gap: 12px; }
.channel-tabs { padding: 0 16px; }
.railway { display: flex; flex-direction: column; gap: 10px; min-width: min(640px, 86vw); }
.railway-sections { padding: 0; }
.railway-list, .railway-choices { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.railway-service { border: 1px solid var(--line); padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; }
.railway-service-head, .railway-actions, .railway-row, .railway-footer, .railway-create { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.railway-status { font-size: 11px; letter-spacing: 0.04em; color: var(--muted); }
.railway-status.success { color: var(--accent); }
.railway-status:is(.failed, .crashed) { color: var(--danger, #e5534b); }
.railway-status.stopped { color: var(--faint); }
.railway-log { margin: 0; max-height: 260px; overflow: auto; padding: 8px; font-size: 11px; line-height: 1.45; background: var(--sunken, rgba(0,0,0,0.25)); white-space: pre-wrap; word-break: break-all; }
.railway-table { border-collapse: collapse; width: 100%; }
.railway-table td { padding: 2px 4px 2px 0; }
.railway-table input { width: 100%; }
.railway-table tr.removed input { text-decoration: line-through; opacity: 0.55; }
.railway-setting { display: grid; grid-template-columns: 220px 1fr; align-items: center; gap: 8px; }
.railway-create input { flex: 1 1 160px; }
.channel-form .field { display: grid; gap: 6px; min-width: 0; margin: 0; padding: 0; border: 0; }
.channel-form .field > input { width: 100%; }
.channel-form .choice-row { display: flex; align-items: center; gap: 6px; min-width: 0; }
/* The proposed repositories float under the input, over what follows it, and move nothing. */
.channel-form .field:has(> .repositories) { position: relative; }
.channel-form .repositories { position: absolute; top: 36px; left: 0; right: 0; z-index: 2; display: grid; max-height: 168px; overflow-y: auto; margin: 0; padding: 4px 0; list-style: none; border: 1px solid var(--hairline); border-radius: 5px; background: var(--panel); box-shadow: 0 4px 12px var(--shadow); }
.channel-form .repository { display: flex; align-items: center; gap: 6px; width: 100%; padding: 5px 8px; border: 0; background: none; color: var(--dim); text-align: left; overflow-wrap: anywhere; }
.channel-form .repository.on { color: var(--accent); font-weight: 600; }
@media (hover: hover) { .channel-form .repository:hover { background: var(--shade-hover); } }
.dialog.channel-dialog { width: min(620px, calc(100vw - 32px)); }
.channel-form .field > input { height: 32px; padding: 0 10px; border: 1px solid var(--hairline); border-radius: 5px; outline: none; background: var(--selected); color: var(--bright); font-size: 13px; }
.channel-form .field > input::placeholder { color: var(--faint); }
.channel-form .field > input:focus { border-color: var(--focus); }
.model-list { display: flex; flex-direction: column; gap: 2px; margin: 0; padding: 0; list-style: none; }
.model-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 36px; padding: 0 8px 0 4px; border: 1px solid transparent; border-radius: 5px; color: var(--muted); cursor: grab; user-select: none; }
.model-row:active { cursor: grabbing; }
.model-row.on { background: var(--selected); color: var(--bright); }
.model-row.dragged { opacity: .4; }
.model-row.drop-before { box-shadow: inset 0 2px 0 var(--accent); }
.model-row.drop-after { box-shadow: inset 0 -2px 0 var(--accent); }
@media (hover: hover) { .model-row:hover { border-color: var(--hairline); } }
.model-row > img, .model-logo-gap { width: 16px; height: 16px; border-radius: 3px; flex-shrink: 0; }
.model-grip { flex-shrink: 0; color: var(--faint); }
.model-label { display: flex; align-items: baseline; gap: 4px; flex: 1; min-width: 0; font-size: 12.5px; }
.model-provider { flex-shrink: 0; color: var(--faint); }
.model-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.model-row.on .model-name { font-weight: 600; }
.switch { position: relative; flex-shrink: 0; width: 30px; height: 17px; padding: 0; border: 1px solid var(--hairline); border-radius: 9px; background: var(--shade); cursor: pointer; transition: background .15s, border-color .15s; }
.switch > i { position: absolute; top: 2px; left: 2px; width: 11px; height: 11px; border-radius: 50%; background: var(--faint); transition: transform .15s, background .15s; }
.switch[aria-checked='true'] { border-color: var(--accent); background: var(--accent-transparent); }
.switch[aria-checked='true'] > i { transform: translateX(13px); background: var(--accent); }
.channel-form .error { margin: 0; color: var(--red); }
.ask textarea { width: 100%; min-height: 64px; padding: 6px 8px; border: 0; outline: none; background: var(--shade); font-size: 13px; line-height: 1.5; resize: vertical; }
.ask textarea:focus { outline: 1px solid var(--focus); }
.ask .hint { margin: 0; }
.ask .suggest .prefix { margin-right: 8px; font-size: 11px; white-space: nowrap; }
.ask .send { justify-self: end; }

/* --- tasks: a thread with a state, so one more line on its root --- */
.task-state { display: inline-flex; align-items: center; gap: 5px; color: var(--muted); font-size: 12px; white-space: nowrap; }
.task-state svg { flex-shrink: 0; }
.task-state.ready, .task-state.claimed { color: var(--accent); }
.task-state.blocked { color: var(--warning); }
.task-state.completed { color: var(--dim); }
.task-state.failed { color: var(--red); }
.task-state.waiting, .task-state.canceled { color: var(--faint); }
.task-line, .task-head { display: flex; flex-wrap: wrap; align-items: center; margin-left: -15px; clip-path: inset(0 0 0 15px); }
/* Each item carries its own separator, and the row clips the ones at its left edge: none starts a line. */
.task-line > *, .task-head > * { position: relative; padding-left: 15px; }
.task-line > *::before, .task-head > *::before { content: '\\00b7'; position: absolute; left: 4px; color: var(--faint); font-weight: 400; }
/* The decision mark is a bordered tag beside the state: a gap, not a separator inside its border. */
.task-line > .decision-mark, .task-head > .decision-mark { margin-left: 8px; padding-left: 5px; }
.task-line > .decision-mark::before, .task-head > .decision-mark::before { content: none; }
.task-line { margin-top: 3px; color: var(--muted); font-size: 12px; }
.task-note { color: var(--dim); overflow-wrap: anywhere; }
.lease { font-variant-numeric: tabular-nums; }
.needs { display: inline-flex; flex-wrap: wrap; gap: 0 8px; }
.need { color: var(--accent); cursor: default; }
.need:hover { text-decoration: underline; }
.need-state { margin-left: 4px; color: var(--faint); }
.need-state.completed { color: var(--muted); }
.need-state.failed { color: var(--red); }

/* The task in full, under the thread's header: it's part of the header, so the hairline goes under it. */
.task-card { flex-shrink: 0; display: grid; gap: 10px; padding: 12px 20px; font-size: 12px; }
.task-head { color: var(--dim); }
.task-head .task-state { font-size: 13px; font-weight: 600; }
.task-card .hint { margin: 0; }

/* Attention keeps a decision in place when its answer lands. */
.attention-list { padding: 12px 20px 24px; }
.attention-list:focus-visible { outline: 1px solid var(--accent); outline-offset: -2px; }
.attention-list .empty { margin-inline: 0; }
.attention-keys { margin: 0 0 10px; font-size: 12px; }
.attention-row { display: grid; gap: 8px; max-width: 840px; padding: 12px; margin-bottom: 8px; overflow-wrap: anywhere; }
.attention-row[aria-current='true'] { background: var(--shade); }
.attention-row p { margin: 0; }
.attention-meta { display: flex; flex-wrap: wrap; gap: 0 8px; align-items: baseline; color: var(--muted); font-size: 12px; }
.attention-status { color: var(--bright); margin-inline-start: auto; white-space: pre-wrap; }
.attention-title { color: var(--dim); cursor: default; }
.attention-title:hover { text-decoration: underline; }
.attention-question, .attention-prose, .attention-label { white-space: pre-wrap; cursor: text; }
.attention-question { color: var(--bright); font-size: 16px; font-weight: 600; }
.attention-row summary { color: var(--muted); cursor: default; }
.attention-row details p { margin-top: 4px; }
.attention-options { display: grid; gap: 8px; margin: 0; padding-inline-start: 22px; }
.attention-options li::marker { color: var(--faint); }
.attention-label { font-weight: 600; }
.attention-choice.act { height: auto; min-height: 26px; white-space: pre-wrap; text-align: start; }
.attention-row[aria-current='true'] .attention-choice { background: var(--shade-hover); }
.attention-choice:not(:disabled):hover { color: var(--accent); }

.composer-task { display: flex; gap: 6px; margin: 8px 8px 0; }
.composer-task .suggest { flex: 1; }
.composer-task .prefix { margin-right: 8px; font-size: 11px; white-space: nowrap; }

/* --- blocks: the data a message carries, as a card where its fence was --- */
.block { max-width: 640px; margin: 6px 0; font-size: 12px; }
.status-line { display: grid; gap: 2px; padding: 3px var(--inset) 3px 16px; font-size: 12px; color: var(--muted); }
.status-line-head { display: flex; align-items: center; gap: 6px; }
.status-line-author { flex-shrink: 0; color: var(--dim); font-weight: 600; }
.status-line-text { min-width: 0; padding-left: 22px; overflow-wrap: anywhere; }
/* A chat, as the thread pane shows one: your messages as bubbles, an agent's turn as plain text with
   its thoughts and actions muted, one line each, folded. No avatars. */
.message.turn-user, .message.turn-agent { grid-template-columns: minmax(0, 1fr); padding: 6px var(--inset) 6px 16px; }
.message.turn-user.continued, .message.turn-agent.continued { padding-top: 0; }
@media (hover: hover) { .message.turn-user:not(.active):hover, .message.turn-agent:not(.active):hover { background: none; } }
.message.turn-user > .body { justify-self: start; max-width: min(720px, 100%); padding: 8px 12px; border-radius: 8px; background: var(--shade); }
.message.turn-user.active > .body { background: var(--shade-hover); }
.message.turn-user .meta-line { margin-bottom: 2px; }
.message.turn-user .text code { background: var(--shade-hover); }
.turn { display: grid; gap: 6px; max-width: 720px; margin: 4px 0 8px; font-size: 12.5px; color: var(--muted); }
.turn summary { list-style: none; display: inline-flex; align-items: center; gap: 6px; max-width: 100%; }
.turn summary::-webkit-details-marker { display: none; }
.turn summary:hover, .turn summary:hover .turn-target { color: var(--dim); }
.turn-chevron { flex-shrink: 0; opacity: .7; transition: transform .12s; }
.turn details[open] > summary .turn-chevron { transform: rotate(90deg); }
.turn-thought > summary { color: var(--faint); }
.turn-thought > p { margin: 4px 0 2px; padding-left: 10px; color: var(--faint); font-style: italic; white-space: pre-wrap; line-height: 1.5; }
.turn-action { display: flex; align-items: center; gap: 6px; min-width: 0; color: var(--muted); }
details.turn-action { display: block; }
.turn-icon { flex-shrink: 0; color: var(--faint); }
.turn-verb { flex-shrink: 0; }
.turn-target { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11.5px; color: var(--faint); }
.turn-action.failed .turn-icon, .turn-action.failed .turn-verb { color: var(--red); }
.turn-action > pre { margin: 4px 0 2px 19px; padding: 6px 8px; max-height: 240px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; border-radius: 4px; font-size: 11.5px; background: var(--shade); color: var(--faint); }
.turn-action.failed > pre { color: var(--red); }
.turn > .text { margin: 2px 0; }
.turn-note { color: var(--muted); }
.turn-note.error, .turn-ended { color: var(--red); }
.turn-note.warning { color: var(--gold); }
.turn-foot { display: flex; flex-wrap: wrap; gap: 4px 10px; color: var(--faint); font-size: 11.5px; }
.turn-foot:empty { display: none; }
.turn-foot.running { color: var(--muted); animation: activity-pulse 1.6s ease-in-out infinite; }
.turn .added { color: var(--accent); }
.turn .removed-lines { color: var(--red); }
.turn-dots { display: inline-flex; gap: 5px; padding: 6px 0 2px; }
.turn-dots i { width: 7px; height: 7px; border-radius: 50%; background: var(--muted); opacity: .3; animation: turn-dot 1.2s ease-in-out infinite; }
.turn-dots i:nth-child(2) { animation-delay: .2s; }
.turn-dots i:nth-child(3) { animation-delay: .4s; }
.decision-mark { display: inline-flex; align-items: center; padding: 0 5px; border: 1px solid var(--accent); border-radius: 3px; color: var(--accent); font-size: 10.5px; font-weight: 600; letter-spacing: .04em; line-height: 16px; white-space: nowrap; }
.decision-mark.review { border-color: var(--warning); color: var(--warning); }
.turn-decision > summary { color: var(--accent); }
.decision-detail { margin: 4px 0 2px; padding-left: 10px; border-left: 2px solid var(--accent); color: var(--dim); }
.decision-detail > p { margin: 0 0 4px; white-space: pre-wrap; line-height: 1.5; }
.decision-detail > pre { margin: 4px 0; padding: 6px 8px; white-space: pre-wrap; overflow-wrap: anywhere; border-radius: 4px; font-size: 11.5px; background: var(--shade); color: var(--faint); }

.block-head { display: flex; align-items: center; gap: 10px; height: 26px; padding: 0 0 0 10px; background: var(--shade); }
.block-head .spacer { flex: 1; }
.block-head .tool { height: 26px; }
.message.active .block-head { background: var(--shade-hover); }
.block-schema { color: var(--bright); font-weight: 600; cursor: default; }
.block-schema:hover { text-decoration: underline; }
.block-schema .faint { font-weight: 400; }
.block-fields { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 2px 14px; margin: 0; padding: 7px 10px; }
.block-field { display: contents; }
.block-field dt { color: var(--faint); }
.block-field dd { margin: 0; color: var(--dim); overflow-wrap: anywhere; }
.block-field a { color: var(--accent); text-decoration: underline; text-decoration-color: var(--faint); text-underline-offset: 3px; }
.block-raw { margin: 0; padding: 7px 10px; color: var(--dim); font-family: inherit; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }

/* --- schemas --- */
.schema-row { display: grid; grid-template-columns: minmax(120px, 200px) auto minmax(0, 1fr) auto; align-items: center; gap: 14px; padding: 6px 20px; }
.schema-row:hover { background: var(--shade); }
.schema-name { color: var(--bright); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.schema-versions { display: flex; gap: 10px; }
.schema-versions .tab { padding: 0; margin: 0; }
.schema-about { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); font-size: 12px; }
.small { font-size: 11px; }
.schema-detail { display: grid; gap: 10px; padding: 4px 20px 16px; max-width: 860px; }
.schema-detail .hint { margin: 0; font-size: 12px; }
.schema-detail code { color: var(--dim); }
.schema-fields { display: grid; grid-template-columns: max-content max-content minmax(0, 1fr); gap: 3px 16px; font-size: 12px; }
.schema-field { display: contents; }
.field-name { color: var(--bright); }
.schema-json { position: relative; }
.schema-json pre { margin: 0; padding: 10px 12px; max-height: 360px; overflow: auto; background: var(--shade); color: var(--dim); font-family: inherit; font-size: 12px; line-height: 1.5; }
.schema-json .act { position: absolute; top: 6px; right: 6px; }
.ask textarea.code { min-height: 180px; font-size: 12px; white-space: pre; }
.suggest.version { width: 64px; flex-shrink: 0; }
.error-text { color: var(--red); }
@media (max-width: 700px) {
  .schema-row { grid-template-columns: minmax(0, 1fr) auto; row-gap: 0; }
  .schema-about { grid-column: 1 / -1; grid-row: 2; }
  .schema-row > .small { display: none; }
}

/* --- access: grants, and the board's answer to who decides a channel --- */
.page h3 { margin: 16px 20px 4px; color: var(--faint); font-size: 11px; font-weight: 500; }
.page h3 b { color: var(--dim); font-weight: 600; }
.page > h3:first-child, .page > section:first-child h3 { margin-top: 6px; }
.grant-row { display: grid; grid-template-columns: 30px minmax(120px, 340px) minmax(0, 1fr) auto auto; align-items: center; gap: 12px; min-height: 30px; padding: 3px 20px; }
.grant-row:hover { background: var(--shade); }
.grant-who { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--bright); }
.grant-who .badge { margin-left: 8px; }
.grant-can { display: flex; flex-wrap: wrap; gap: 4px; min-width: 0; }
.grant-can b { color: var(--bright); font-weight: 600; }
.grant-row .act { height: 22px; }
.explain { display: grid; gap: 8px; padding: 2px 20px 6px; }
.explain-ask { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.explain-ask > .suggest { width: 200px; }
.who-fields { display: flex; flex-wrap: wrap; gap: 6px; }
.who-fields .suggest { width: 190px; }
.ask .who-fields .suggest { flex: 1; width: auto; min-width: 150px; }
.ask textarea.code.can { min-height: 64px; }
.explained { display: grid; gap: 6px; max-width: 900px; padding: 10px 12px; background: var(--shade); }
.explained p { margin: 0; color: var(--dim); font-size: 14px; }
.explained b { color: var(--bright); font-weight: 600; }
.explained .facts { grid-template-columns: 56px minmax(0, 1fr); font-size: 12px; }
.explained .grant-row { margin: 0 -12px; padding: 3px 12px; }
.explained .grant-row:hover { background: var(--shade-hover); }
@media (max-width: 700px) {
  .grant-row { grid-template-columns: 30px minmax(0, 1fr) auto; row-gap: 2px; padding: 5px 20px; }
  .grant-can { grid-column: 2 / -1; grid-row: 2; }
  .grant-row > .small { display: none; }
}

/* --- schedules, watchers, and a thread's copies --- */
.sched-row { display: grid; grid-template-columns: 64px minmax(110px, 200px) minmax(0, 1fr) auto auto 52px; align-items: center; gap: 14px; min-height: 30px; padding: 3px 20px; }
.sched-row:hover { background: var(--shade); }
.sched-when { color: var(--bright); white-space: nowrap; }
.sched-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dim); }
.sched-row .act { height: 22px; justify-self: end; }
.watch-row { display: grid; grid-template-columns: minmax(90px, 180px) minmax(0, 1fr); gap: 14px; padding: 4px 20px; }
.watch-row:hover { background: var(--shade); }
.watch-id { color: var(--bright); }
.watch-row code { color: var(--dim); overflow-wrap: anywhere; }
.thread-facts { flex-shrink: 0; padding: 10px 20px; font-size: 12px; }
.thread-facts .fact { display: contents; }
.copies { display: flex; flex-wrap: wrap; gap: 2px 12px; }
.label-add.end { justify-content: flex-end; gap: 12px; }
.suggest input:disabled { opacity: 0.4; }
@media (max-width: 700px) {
  .sched-row { grid-template-columns: 64px minmax(0, 1fr) auto; row-gap: 0; padding: 5px 20px; }
  .sched-row > .faint { display: none; }
  .sched-text { grid-column: 1 / -1; grid-row: 2; }
}


/* --- a narrow page: the sidebar comes over it when it's asked for --- */
.shell.nav .sidebar { display: grid; z-index: var(--nav-layer); width: min(280px, 84vw) !important; opacity: 1 !important; }
.shell.nav .scrim { display: block; grid-area: 1 / 1 / -1 / 2; z-index: calc(var(--nav-layer) - 1); background: var(--scrim); }
:is(.brand .at, .sidebar h2, .sidebar .count, .whoami, .header .meta, .live, .time, .id, .divider, .where, .edited, .undelivered, .hint, .task-state) { font: var(--metadata); }
:is(.chip, .label button, .file button, .sidebar h2 .tool, .replies, .clear) { min-height: 24px; }
.emoji-grid { grid-template-columns: repeat(12, minmax(0, 1fr)); width: min(372px, calc(100vw - 24px)); }
@media (max-width: 700px) {
  .composer-footer .hint { display: none; }
  .composer-footer .send { margin-left: auto; }
}

.toasts { position: fixed; right: 16px; bottom: 16px; display: grid; gap: 8px; z-index: 60; }
.toast { max-width: 420px; padding: 8px 12px; background: var(--bg); box-shadow: 0 4px 12px var(--shadow); color: var(--bright); }

/* --- a touch device: iOS zooms in on a focused field whose text is under
   16px, so every field gets 16px there; important so it beats each field's
   own size, whatever its selector. A desktop keeps the sizes above. --- */
@media (pointer: coarse) {
  input, textarea, select { font-size: 16px !important; }
  :is(.header .tool, .sidebar .item, .brand .tool, .whoami, .send, .composer-footer .tool) { min-height: 44px; }
  :is(.header .tool, .brand .tool, .composer-footer .tool) { min-width: 44px; }
}

/* --- wordmark --- */
.brand .wordmark {
  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font: 700 1rem/1.25rem 'Avenir Next Condensed', 'Arial Narrow', 'Liberation Sans Narrow', sans-serif;
  font-stretch: condensed;
  letter-spacing: .06em;
}
.brand .wordmark:hover { color: var(--accent); }

.home-queue h2 { padding-bottom: 1px; }

/* operations: a live schematic beside the ledger and each component's details */
.operations-view {
  --ops-command: light-dark(#8a5c0a, #f2c879); --ops-telemetry: light-dark(#2f6b3d, #9fd0a4); --ops-result: light-dark(#6a3d8f, #c9a9e6);
  --ops-external: light-dark(#9a2f45, #eba3a8); --ops-ok: light-dark(#2f6b3d, #9fd0a4);
  overflow: hidden; padding: 12px var(--inset) 14px;
}
.ops-layout { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr) minmax(17rem, 21rem); gap: 12px; }
.ops-main { display: flex; flex-direction: column; gap: 12px; min-width: 0; min-height: 0; }
.ops-side { display: flex; flex-direction: column; gap: 12px; min-height: 0; overflow: auto; padding-right: 2px; scrollbar-width: thin; }
.ops-card { border-radius: 8px; background: var(--panel); min-width: 0; }
.ops-card-head { display: flex; align-items: baseline; gap: 10px; padding: 9px 12px 8px; border-bottom: 1px solid var(--shade); }
.ops-card-head h2 { margin: 0; font: 600 13px var(--display); letter-spacing: .02em; color: var(--bright); white-space: nowrap; }
.ops-card-head .spacer { flex: 1; }
.ops-card-head .act { height: 20px; padding: 0 6px; font-size: 11px; align-self: center; }
.ops-head-meta { font: var(--metadata); color: var(--faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.ops-card h3 { margin: 10px 12px 2px; font: 600 11px var(--display); letter-spacing: .06em; text-transform: uppercase; color: var(--faint); }
.ops-note { margin: 0; padding: 6px 12px 9px; color: var(--warning); font: var(--metadata); overflow-wrap: anywhere; }
.ops-empty { margin: 0; padding: 14px 12px; color: var(--faint); font: var(--metadata); }
.ops-legend { display: flex; flex-wrap: wrap; justify-content: flex-start; gap: 4px 12px; margin: 0; padding: 4px 12px 10px; list-style: none; font: var(--metadata); color: var(--faint); }
.ops-legend li { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
.ops-legend i { width: 6px; height: 6px; border-radius: 50%; }
.ops-status { display: inline-flex; align-items: center; gap: 6px; font: var(--metadata); color: var(--muted); white-space: nowrap; }
.ops-status i { width: 6px; height: 6px; border-radius: 50%; background: var(--faint); opacity: .6; }
.ops-status.ok i { background: var(--ops-ok); opacity: 1; box-shadow: 0 0 0 3px color-mix(in srgb, var(--ops-ok) 18%, transparent); }
.ops-status.warn i { background: var(--warning); opacity: 1; }
.ops-status.fault { color: var(--red); }
.ops-status.fault i { background: var(--red); opacity: 1; }

/* the schematic */
.ops-stage { flex: none; overflow: hidden; }
.ops-schematic { display: block; width: 100%; height: auto; user-select: none; font-family: var(--mono); }
.ops-schematic .grid-dot { fill: var(--hairline); opacity: .35; }
.ops-schematic .divider { stroke: var(--hairline); stroke-opacity: .45; }
.ops-schematic .column-label { fill: var(--faint); font: 600 10.5px var(--display); letter-spacing: .16em; }
.ops-schematic .link { fill: none; stroke: var(--hairline); stroke-width: 1.25; stroke-linecap: round; transition: stroke .9s ease-out, stroke-width .9s ease-out, stroke-opacity .9s ease-out; }
.ops-schematic .link.used { stroke: var(--muted); stroke-opacity: .5; }
.ops-schematic .link.launch { stroke-opacity: 0; }
.ops-schematic .link.down { stroke-dasharray: 2 5; stroke-opacity: .6; }
.ops-schematic .link.hot { stroke: var(--hot); stroke-opacity: .85; stroke-width: 1.75; transition-duration: .12s; }
.ops-schematic .settled .link { stroke-opacity: .35; }
.ops-schematic .frame { fill: var(--bg); stroke: var(--gold); stroke-opacity: .7; stroke-width: 1.1; transition: stroke .3s, stroke-opacity .3s; }
.ops-schematic .node-title { fill: var(--bright); font: 600 14px var(--display); letter-spacing: .01em; }
.ops-schematic .node-line { fill: var(--dim); font-size: 12px; }
.ops-schematic .node-line.small { font-size: 8.5px; fill: var(--muted); }
.ops-schematic .node-line.faint, .ops-schematic .node-detail { fill: var(--faint); font: 400 11px var(--mono); }
.ops-schematic .node-figure { fill: var(--bright); font-size: 12px; font-variant-numeric: tabular-nums; }
.ops-schematic .node.down .frame { stroke: var(--hairline); stroke-opacity: 1; stroke-dasharray: 3 4; }
.ops-schematic .node.down .node-title { fill: var(--muted); }
.ops-schematic .node.fault .frame { stroke: var(--red); stroke-opacity: 1; stroke-dasharray: none; }
.ops-schematic .led { fill: var(--faint); opacity: .5; }
.ops-schematic .led.ok { fill: var(--ops-ok); opacity: 1; }
.ops-schematic .led.warn { fill: var(--warning); opacity: 1; }
.ops-schematic .led.fault { fill: var(--red); opacity: 1; }
.ops-schematic .relay .ring { fill: none; stroke: var(--gold); stroke-opacity: .45; stroke-width: 1; stroke-dasharray: 1 5; animation: ops-march var(--spin, 20s) linear infinite; }
@keyframes ops-march { to { stroke-dashoffset: -120; } }
/* A box's words are HTML in its frame: picture and name first, then a line per detail. */
.ops-schematic foreignObject { overflow: visible; pointer-events: none; }
.ops-node { box-sizing: border-box; height: 100%; padding: 9px 26px 8px 12px; display: flex; flex-direction: column; justify-content: center; gap: 3px; font-family: var(--mono); }
.ops-node-head { display: flex; align-items: center; gap: 7px; min-width: 0; }
.ops-node-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--bright); font: 600 14px var(--display); letter-spacing: .01em; }
.ops-node-figure { margin-left: auto; padding-left: 8px; color: var(--bright); font-size: 12px; font-variant-numeric: tabular-nums; }
.ops-node-detail { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--faint); font-size: 11px; }
.ops-node-detail .state { color: var(--dim); }
.ops-node-detail .state-running { color: var(--ops-ok); }
.ops-node-detail .state-waiting_answer { color: var(--warning); }
.ops-schematic .node.down .ops-node-name { color: var(--muted); }
.ops-schematic .worker { cursor: pointer; outline: none; }
.ops-schematic .worker:hover .frame { stroke-opacity: 1; }
.ops-schematic .worker:focus-visible .frame, .ops-schematic .worker.selected .frame { stroke: var(--accent); stroke-opacity: 1; stroke-width: 1.6; }
.ops-schematic .worker.settled { opacity: .5; }
.ops-schematic .worker.waiting .frame { stroke: var(--warning); stroke-opacity: 1; }
.ops-schematic .worker .pulse { fill: none; stroke: var(--ops-ok); stroke-width: 1.2; transform-box: fill-box; transform-origin: center; animation: ops-pulse .9s ease-out forwards; pointer-events: none; }
@keyframes ops-pulse { from { transform: scale(1); opacity: .9; } to { transform: scale(3.2); opacity: 0; } }
.ops-schematic .worker .track { fill: var(--shade); }
.ops-schematic .worker .sweep { fill: var(--ops-telemetry); transform-box: fill-box; transform-origin: left center; animation: ops-sweep 1.4s ease-out forwards; }
@keyframes ops-sweep { 0% { transform: scaleX(0); opacity: .9; } 70% { transform: scaleX(1); opacity: .9; } 100% { transform: scaleX(1); opacity: 0; } }
.ops-schematic .state { fill: var(--dim); }
.ops-schematic .state-running { fill: var(--ops-ok); }
.ops-schematic .state-waiting_answer { fill: var(--warning); }
.ops-schematic .worker.fault .state { fill: var(--red); }
.ops-schematic .packet { fill: var(--c); pointer-events: none; }
.ops-schematic .packet.ring { fill: var(--bg); stroke: var(--c); stroke-width: 1.5; }
.ops-schematic .packet-label { fill: var(--c); font-size: 10.5px; paint-order: stroke; stroke: var(--panel); stroke-width: 3px; stroke-linejoin: round; pointer-events: none; }

/* label: value rows */
.ops-facts { margin: 0; padding: 6px 12px 10px; font: var(--metadata); }
.ops-facts > div { display: flex; align-items: baseline; gap: 12px; padding: 3px 0; border-bottom: 1px dotted var(--shade); }
.ops-facts > div:last-child { border-bottom: none; }
.ops-facts dt { flex: none; color: var(--faint); }
.ops-facts dd { flex: 1; min-width: 0; margin: 0; text-align: right; color: var(--dim); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.ops-facts dd a { color: var(--accent); text-decoration: underline; text-underline-offset: 2px; }
.ops-facts .faint, .ops-facts .state { color: var(--faint); }
.ops-facts .state-running { color: var(--ops-ok); }
.ops-facts .state-waiting_answer { color: var(--warning); }

/* the ledger */
.ops-figures { display: grid; grid-template-columns: 1.4fr 1fr 1fr; gap: 8px; padding: 12px 12px 4px; }
.ops-figures > div { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.ops-figure { font: 600 22px/1.1 var(--display); color: var(--bright); font-variant-numeric: tabular-nums; animation: ops-settle .8s ease-out; }
.ops-figure.small { font-size: 15px; color: var(--dim); padding-top: 6px; animation: none; }
.ops-figure-label { font: var(--metadata); color: var(--faint); }
@keyframes ops-settle { from { color: var(--accent); } }
.ops-hours { padding: 8px 12px 4px; }
.ops-bars { display: flex; align-items: flex-end; gap: 2px; height: 38px; border-bottom: 1px solid var(--hairline); }
.ops-bars i { flex: 1; min-width: 0; border-radius: 1px 1px 0 0; background: var(--shade-hover); transition: height .5s ease-out; }
.ops-bars i.spent { background: var(--gold); opacity: .8; }
.ops-bars i:hover { opacity: 1; background: var(--accent); }
.ops-axis { display: flex; justify-content: space-between; padding-top: 3px; font: 10.5px/1.2 var(--mono); color: var(--faint); }

/* the message log */
.ops-messages { flex: 1; min-height: 9rem; display: flex; flex-direction: column; }
.ops-log { flex: 1; min-height: 0; overflow: auto; list-style: none; margin: 0; padding: 4px 0; font: var(--metadata); scrollbar-width: thin; }
.ops-log li { display: grid; grid-template-columns: auto 7px minmax(0, 1fr); align-items: center; gap: 10px; padding: 2px 12px; animation: ops-arrive .6s ease-out; }
.ops-log li:hover { background: var(--shade); }
.ops-log li.fault .ops-log-text { color: var(--red); }
.ops-log i { width: 6px; height: 6px; border-radius: 50%; }
.ops-log time { color: var(--faint); font-variant-numeric: tabular-nums; }
.ops-log-kind { color: var(--faint); }
.ops-log-text { color: var(--dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ops-log li:has(.ops-sources) { grid-template-columns: auto 7px minmax(0, 1fr) auto; }
.ops-sources { display: inline-flex; align-items: center; gap: 3px; vertical-align: middle; }
.ops-sources img { width: 13px; height: 13px; border-radius: 3px; object-fit: contain; }
.ops-sources.spin img { animation: ops-spin 1.6s linear infinite; }
.ops-tasks { flex: 1; min-height: 0; overflow: auto; padding: 4px 0; font: var(--metadata); scrollbar-width: thin; }
.ops-task > summary { list-style: none; cursor: pointer; display: grid; grid-template-columns: 4rem minmax(0, 1fr) auto auto auto auto; align-items: center; gap: 12px; padding: 4px 12px; }
.ops-task > summary::-webkit-details-marker { display: none; }
.ops-task > summary:hover, .ops-task[open] > summary { background: var(--shade); }
.ops-task-id { color: var(--bright); font-variant-numeric: tabular-nums; }
.ops-task-state { color: var(--dim); }
.ops-task-figure, .ops-task > summary time { color: var(--faint); font-variant-numeric: tabular-nums; }
.ops-task-fault { color: var(--red); }
.ops-task .ops-log { padding: 0 0 6px 16px; overflow: visible; }

@keyframes ops-arrive { from { background: var(--shade-hover); } }
@keyframes activity-pulse { 50% { opacity: .45; } }
@keyframes turn-dot { 0%, 80%, 100% { opacity: .3; } 40% { opacity: 1; } }

@media (max-width: 64rem) {
  .operations-view { overflow: auto; }
  .ops-layout { flex: none; grid-template-columns: minmax(0, 1fr); }
  .ops-side { overflow: visible; }
  .ops-messages { flex: none; }
  .ops-log { max-height: 18rem; }
  .ops-legend { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  .ops-schematic .relay .ring, .ops-schematic .worker .pulse, .ops-schematic .worker .sweep, .ops-figure, .ops-log li, .ops-sources.spin img, .turn-dots i { animation: none; }
  .ops-schematic .worker .pulse { display: none; }
  .ops-schematic .link { transition: none; }
}
`
