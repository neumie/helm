// Design lint baseline: every finding of app/src/design/lint.ts that is allowed to stay, with the decision
// (docs/plans/design-system/spec.md D<n>), ruling (docs/design-system.md §9 ruling N) or plan stage (S<n>) that
// keeps it. tests/design-lint.test.ts fails on a finding missing here and on an entry with no finding left
// (the value was fixed: remove it). Regenerate with `node --import tsx app/scripts/design-lint.ts --write-baseline`,
// which keeps the reasons below for entries that still match; edit reasons by hand. Never add an entry to let
// new code through: use a token, or get a ruling first.
//
// Format, under `## <rule>` and `### <file>` headers: <selector> | <property> | <value> | <reason>
import { type AllowlistEntry, parseBaseline } from './lint'

export const DESIGN_LINT_BASELINE = String.raw`
## raw-color
### app/src/renderer/remote/remote.css
.remote-composer-actions .menu-panel | box-shadow | 0 16px 44px rgb(0 0 0 / 48%) | D7 Remote palette
.remote-composer-actions .remote-send.btn-primary | background | #fff | D7 Remote palette
.remote-composer-actions .remote-send.btn-primary | color | #0d0d0d | D7 Remote palette
.remote-navigation-dismiss | background | rgb(0 0 0 / 58%) | D7 Remote palette
.remote-navigation-menu | box-shadow | 20px 0 60px rgb(0 0 0 / 48%) | D7 Remote palette
.remote-row-menu | box-shadow | 0 8px 24px rgb(0 0 0 / 35%) | D7 Remote palette
.remote-sheet | box-shadow | 0 20px 60px rgb(0 0 0 / 55%) | D7 Remote palette
.remote-sheet-dismiss | background | rgb(0 0 0 / 58%) | D7 Remote palette
@media (hover: hover) .remote-composer-actions .remote-send.btn-primary:hover:not(:disabled) | background | rgb(255 255 255 / 88%) | D7 Remote palette
body.remote-page, #remote-root | background | var(--remote-page, #0d0d0d) | D7 Remote palette
### app/src/renderer/viewer/viewer.css
.viewer-pdf-paper | background | #fff | S2 gives the literal a token (§9 ruling 9)
### extension/src/popup.html
.models .group | color | #808080 | D9 extension popup (moves onto Helm tokens)
.status | color | #6a9955 | D9 extension popup (moves onto Helm tokens)
body | background | #252526 | D9 extension popup (moves onto Helm tokens)
body | color | #cccccc | D9 extension popup (moves onto Helm tokens)
h1 | color | #007acc | D9 extension popup (moves onto Helm tokens)
input | background | #1e1e1e | D9 extension popup (moves onto Helm tokens)
input | border | 1px solid #3c3c3c | D9 extension popup (moves onto Helm tokens)
input | color | #cccccc | D9 extension popup (moves onto Helm tokens)
input:focus | border-color | #007acc | D9 extension popup (moves onto Helm tokens)
label | color | #808080 | D9 extension popup (moves onto Helm tokens)
### extension/src/popup.ts
statusEl.style in module | color | #6a9955 | D9 extension popup (moves onto Helm tokens)
statusEl.style in module | color | #f14c4c | D9 extension popup (moves onto Helm tokens)
statusEl.style in module | color | #f14c4c | D9 extension popup (moves onto Helm tokens)

## token-definition
### app/src/renderer/document-review/document-review.css
.document-review[data-review-theme="light"] | --accent | #176ac2 | §2.8 Review light scope (§9 ruling 10)
.document-review[data-review-theme="light"] | --accent-fill | #176ac2 | §2.8 Review light scope (§9 ruling 10)
.document-review[data-review-theme="light"] | --accent-fill-hover | #125ba8 | §2.8 Review light scope (§9 ruling 10)
.document-review[data-review-theme="light"] | --chrome | #f1f0ed | §2.8 Review light scope (§9 ruling 10)
.document-review[data-review-theme="light"] | --danger | #b91c1c | §2.8 Review light scope (§9 ruling 10)
.document-review[data-review-theme="light"] | --danger-soft | color-mix(in srgb, var(--danger) 15%, transparent) | §2.8 Review light scope (§9 ruling 10)
.document-review[data-review-theme="light"] | --fill-raised | rgba(0, 0, 0, 0.09) | §2.8 Review light scope (§9 ruling 10)
.document-review[data-review-theme="light"] | --fill-strong | rgba(0, 0, 0, 0.13) | §2.8 Review light scope (§9 ruling 10)
.document-review[data-review-theme="light"] | --fill-subtle | rgba(0, 0, 0, 0.05) | §2.8 Review light scope (§9 ruling 10)
.document-review[data-review-theme="light"] | --hairline | rgba(0, 0, 0, 0.07) | §2.8 Review light scope (§9 ruling 10)
.document-review[data-review-theme="light"] | --hairline-strong | rgba(0, 0, 0, 0.16) | §2.8 Review light scope (§9 ruling 10)
.document-review[data-review-theme="light"] | --pane | #faf9f6 | §2.8 Review light scope (§9 ruling 10)
.document-review[data-review-theme="light"] | --success | #267347 | §2.8 Review light scope (§9 ruling 10)
.document-review[data-review-theme="light"] | --text-0 | #24272c | §2.8 Review light scope (§9 ruling 10)
.document-review[data-review-theme="light"] | --text-1 | #60646c | §2.8 Review light scope (§9 ruling 10)
.document-review[data-review-theme="light"] | --text-2 | #62666e | §2.8 Review light scope (§9 ruling 10)
.document-review[data-review-theme="light"] | --thumb | color-mix(in srgb, var(--text-0) 14%, transparent) | §2.8 Review light scope (§9 ruling 10)
.document-review[data-review-theme="light"] | --thumb-hover | color-mix(in srgb, var(--text-0) 24%, transparent) | §2.8 Review light scope (§9 ruling 10)
.document-review[data-review-theme="light"] | --warn | #8a5a0a | §2.8 Review light scope (§9 ruling 10)
.document-review[data-review-theme="light"] | --warn-soft | color-mix(in srgb, var(--warn) 15%, transparent) | §2.8 Review light scope (§9 ruling 10)
.document-review[data-review-theme="light"] | --well | #ebeae6 | §2.8 Review light scope (§9 ruling 10)
.review-reading | --ui-scale | calc(var(--review-ui-scale) * var(--review-zoom, 1)) | D7 surface reach (Review keeps its own text scale)
### app/src/renderer/remote/remote.css
.remote-workspace, .remote-login, .remote-empty | --chrome | #1c1c1e | D7 Remote palette
.remote-workspace, .remote-login, .remote-empty | --fill-raised | rgb(255 255 255 / 11%) | D7 Remote palette
.remote-workspace, .remote-login, .remote-empty | --fill-subtle | rgb(255 255 255 / 5.5%) | D7 Remote palette
.remote-workspace, .remote-login, .remote-empty | --hairline | rgb(255 255 255 / 8%) | D7 Remote palette
.remote-workspace, .remote-login, .remote-empty | --hairline-strong | rgb(255 255 255 / 16%) | D7 Remote palette
.remote-workspace, .remote-login, .remote-empty | --pane | var(--remote-page, #0d0d0d) | D7 Remote palette
.remote-workspace, .remote-login, .remote-empty | --well | #1a1a1a | D7 Remote palette
### app/src/renderer/viewer/viewer.css
.viewer-stage | --ui-scale | calc(var(--review-ui-scale) * var(--review-zoom, 1)) | D7 surface reach (Review keeps its own text scale)

## raw-z-index
### app/src/renderer/agent-dock/agent-dock.css
.agent-dock-agent::before | z-index | -1 | S2 adds z/motion tokens (pending D2)
.agent-dock-resize | z-index | 3 | S2 adds z/motion tokens (pending D2)
.agent-dock::before | z-index | 1 | S2 adds z/motion tokens (pending D2)
### app/src/renderer/document-review/document-review.css
.review-selection-actions | z-index | 3 | S2 adds z/motion tokens (pending D2)
### app/src/renderer/no-terminals.css
#no-terms | z-index | 2 | S2 adds z/motion tokens (pending D2)
### app/src/renderer/remote/remote.css
.remote-back::before | z-index | -1 | S2 adds z/motion tokens (pending D2)
.remote-chat > .remote-header | z-index | 4 | S2 adds z/motion tokens (pending D2)
.remote-compose-surface::before | z-index | -1 | S2 adds z/motion tokens (pending D2)
.remote-composer | z-index | 3 | S2 adds z/motion tokens (pending D2)
.remote-information-view | z-index | 10 | S2 adds z/motion tokens (pending D2)
.remote-jump | z-index | 2 | S2 adds z/motion tokens (pending D2)
.remote-navigation-scrim | z-index | 70 | S2 adds z/motion tokens (pending D2)
.remote-navigation-trigger::before | z-index | -1 | S2 adds z/motion tokens (pending D2)
.remote-row-menu | z-index | 2 | S2 adds z/motion tokens (pending D2)
.remote-sheet-scrim | z-index | 60 | S2 adds z/motion tokens (pending D2)
### app/src/renderer/sidebar/sidebar.css
.action-bar | z-index | 10 | S2 adds z/motion tokens (pending D2)
.action-row::after | z-index | -1 | S2 adds z/motion tokens (pending D2)
.menu-panel | z-index | 40 | S2 adds z/motion tokens (pending D2)
.push-header | z-index | 10 | S2 adds z/motion tokens (pending D2)
.sheet | z-index | 1 | S2 adds z/motion tokens (pending D2)
.sheet-layer | z-index | 60 | S2 adds z/motion tokens (pending D2)
.sheet-scrim | z-index | 0 | S2 adds z/motion tokens (pending D2)
.swipe-scrim | z-index | 30 | S2 adds z/motion tokens (pending D2)
### app/src/renderer/signals/signals.css
.signals-band | z-index | 1 | S2 adds z/motion tokens (pending D2)
### app/src/renderer/terminal-context-menu.css
.menu-panel.menu-fixed | z-index | 40 | S2 adds z/motion tokens (pending D2)
### app/src/renderer/terminal-tabs.css
.tab-drag-preview | z-index | 60 | S2 adds z/motion tokens (pending D2)
.tab-group-drag-preview | z-index | 60 | S2 adds z/motion tokens (pending D2)
### app/src/renderer/terminal-well.css
.term-holder[data-reveal]::after | z-index | 9 | S2 adds z/motion tokens (pending D2)
.term-mount .term-frame-freeze | z-index | 8 | S2 adds z/motion tokens (pending D2)
.term-scrollbar | z-index | 2 | S2 adds z/motion tokens (pending D2)
### app/src/renderer/toast.css
#toasts | z-index | 100 | S2 adds z/motion tokens (pending D2)
### app/src/renderer/viewer/viewer.css
.viewer-grid-band | z-index | 3 | S2 adds z/motion tokens (pending D2)
.viewer-grid-band > .viewer-grid-number | z-index | 2 | S2 adds z/motion tokens (pending D2)
.viewer-grid-cells | z-index | 0 | S2 adds z/motion tokens (pending D2)
.viewer-grid-corner | z-index | 1 | S2 adds z/motion tokens (pending D2)
.viewer-grid-letters | z-index | 4 | S2 adds z/motion tokens (pending D2)
.viewer-grid-numbers | z-index | 2 | S2 adds z/motion tokens (pending D2)
.viewer-grid-selection, .viewer-grid-active | z-index | 1 | S2 adds z/motion tokens (pending D2)
.viewer-pdf-text | z-index | 0 | S2 adds z/motion tokens (pending D2)
.viewer-pdf-text .viewer-pdf-eoc | z-index | 0 | S2 adds z/motion tokens (pending D2)
.viewer-pdf-text > :not(.markedContent), .viewer-pdf-text .markedContent span:not(.markedContent) | z-index | 1 | S2 adds z/motion tokens (pending D2)
### extension/src/widget.styles.ts
.vg-card | z-index | 2147483647 | S2 adds z/motion tokens (pending D2)
.vg-model__menu | z-index | 40 | S2 adds z/motion tokens (pending D2)
.vg-more [role="menu"] | z-index | 5 | S2 adds z/motion tokens (pending D2)
.vg-pill | z-index | 2147483647 | S2 adds z/motion tokens (pending D2)

## raw-duration
### app/src/renderer/agent-dock/agent-dock.css
.agent-dock-agent-glyph[data-tone="working"] | animation | agent-dock-pulse 1.6s ease-in-out infinite | S2 adds z/motion tokens (pending D2)
.agent-dock-agent::before | transition | background-color 140ms ease-out | S2 adds z/motion tokens (pending D2)
.agent-dock-agents-n | transition | color 140ms ease-out | S2 adds z/motion tokens (pending D2)
.agent-dock-choice | transition | background-color 140ms ease-out | S2 adds z/motion tokens (pending D2)
.agent-dock-entry, .agent-dock-more, .agent-dock-agents-entry | transition | background-color 140ms ease-out | S2 adds z/motion tokens (pending D2)
.agent-dock-entry-name | transition | color 140ms ease-out | S2 adds z/motion tokens (pending D2)
.agent-dock-group-option | transition | color 140ms ease-out | S2 adds z/motion tokens (pending D2)
.agent-dock-prompt | transition | border-color 140ms ease-out | S2 adds z/motion tokens (pending D2)
.agent-dock-qtab | transition | color 140ms ease-out | S2 adds z/motion tokens (pending D2)
.agent-dock-reveal-link | transition | color 140ms ease-out, text-decoration-color 140ms ease-out | S2 adds z/motion tokens (pending D2)
.agent-dock-title-btn | transition | background-color 140ms ease-out, color 140ms ease-out | S2 adds z/motion tokens (pending D2)
.agent-dock::before | transition | background-color 140ms ease-out | S2 adds z/motion tokens (pending D2)
@media (prefers-reduced-motion: no-preference) .agent-dock-row [data-arrival] | animation | agent-dock-arrival-fill 1.4s ease-out 1 | S2 adds z/motion tokens (pending D2)
@media (prefers-reduced-motion: no-preference) .agent-dock:has(.agent-dock-row [data-arrival="turn"])::before | animation | agent-dock-arrival-edge-accent 1.4s ease-out 1 | S2 adds z/motion tokens (pending D2)
@media (prefers-reduced-motion: no-preference) .agent-dock:has(.agent-dock-row [data-arrival]:not([data-arrival="turn"]))::before | animation | agent-dock-arrival-edge-warn 1.4s ease-out 1 | S2 adds z/motion tokens (pending D2)
### app/src/renderer/background-terminals.css
#bg-toggle | transition | transform 140ms ease-out, background-color 140ms ease-out, color 140ms ease-out | S2 adds z/motion tokens (pending D2)
.bg-group-header-row | transition | background-color 140ms ease-out | S2 adds z/motion tokens (pending D2)
.bg-row | transition | background-color 140ms ease-out | S2 adds z/motion tokens (pending D2)
### app/src/renderer/button.css
.btn | transition | background-color 140ms ease-out, color 140ms ease-out | S2 adds z/motion tokens (pending D2)
### app/src/renderer/document-review/document-review.css
.review-screenshot-remove | transition | opacity 120ms ease-out | S2 adds z/motion tokens (pending D2)
### app/src/renderer/panes.css
#divider | transition | background-color 120ms ease-out | S2 adds z/motion tokens (pending D2)
### app/src/renderer/remote/remote.css
.remote-back::before | transition | background-color 140ms ease-out | S2 adds z/motion tokens (pending D2)
.remote-composer-actions .menu-panel | animation | remote-popover-in 140ms ease-out both | S2 adds z/motion tokens (pending D2)
.remote-information-view | animation | remote-reading-view-in 160ms ease-out both | S2 adds z/motion tokens (pending D2)
.remote-navigation-dismiss | animation | remote-scrim-in 160ms ease-out both | S2 adds z/motion tokens (pending D2)
.remote-navigation-item | transition | background-color 140ms ease-out, color 140ms ease-out | S2 adds z/motion tokens (pending D2)
.remote-navigation-menu | animation | remote-navigation-in 180ms cubic-bezier(0.22, 1, 0.36, 1) both | S2 adds z/motion tokens (pending D2)
.remote-navigation-trigger::before | transition | background-color 140ms ease-out | S2 adds z/motion tokens (pending D2)
.remote-row-menu | animation | remote-popover-in 140ms ease-out both | S2 adds z/motion tokens (pending D2)
.remote-sheet | animation | remote-sheet-in 180ms cubic-bezier(0.22, 1, 0.36, 1) both | S2 adds z/motion tokens (pending D2)
.remote-sheet-dismiss | animation | remote-scrim-in 160ms ease-out both | S2 adds z/motion tokens (pending D2)
.remote-sheet-option | transition | background-color 140ms ease-out, color 140ms ease-out | S2 adds z/motion tokens (pending D2)
.remote-usage | animation | remote-reading-view-in 160ms ease-out both | S2 adds z/motion tokens (pending D2)
@media (min-width: 1200px) .remote-information-rail | animation | remote-rail-in 160ms ease-out both | S2 adds z/motion tokens (pending D2)
### app/src/renderer/sidebar/sidebar.css
.action-row::after | transition | opacity 140ms ease-out | S2 adds z/motion tokens (pending D2)
.attachment-row | transition | background-color 140ms ease-out | S2 adds z/motion tokens (pending D2)
.clamp-cue | transition | color 140ms ease-out | S2 adds z/motion tokens (pending D2)
.dot-pulse | animation | dot-pulse 1.6s ease-in-out infinite | S2 adds z/motion tokens (pending D2)
.field-reset | transition | color 140ms ease-out | S2 adds z/motion tokens (pending D2)
.icon-btn | transition | background-color 140ms ease-out, color 140ms ease-out | S2 adds z/motion tokens (pending D2)
.input | transition | border-color 140ms ease-out | S2 adds z/motion tokens (pending D2)
.item-row | transition | background-color 140ms ease-out | S2 adds z/motion tokens (pending D2)
.menu-panel | animation | menu-in 120ms ease-out | S2 adds z/motion tokens (pending D2)
.nav-pop-out | animation | nav-out 120ms ease-out forwards | S2 adds z/motion tokens (pending D2)
.nav-push-in | animation | nav-in 150ms ease-out | S2 adds z/motion tokens (pending D2)
.nav-under-away | animation | nav-under-away 150ms ease-out | S2 adds z/motion tokens (pending D2)
.nav-under-back | animation | nav-under-back 120ms ease-out | S2 adds z/motion tokens (pending D2)
.new-item-prompt-field::before | transition | background-color 140ms ease-out | S2 adds z/motion tokens (pending D2)
.project-trigger | transition | background-color 140ms ease-out, color 140ms ease-out | S2 adds z/motion tokens (pending D2)
.segment | transition | background-color 140ms ease-out, color 140ms ease-out | S2 adds z/motion tokens (pending D2)
.sheet | animation | sheet-in 150ms ease-out | S2 adds z/motion tokens (pending D2)
.sheet-scrim | animation | scrim-in 150ms ease-out | S2 adds z/motion tokens (pending D2)
.task-metadata summary::after | transition | transform 140ms ease-out | S2 adds z/motion tokens (pending D2)
.toggle | transition | background-color 140ms ease-out, border-color 140ms ease-out | S2 adds z/motion tokens (pending D2)
.toggle-knob | transition | transform 140ms ease-out | S2 adds z/motion tokens (pending D2)
### app/src/renderer/signals/signals.css
.signals-list-btn | transition | color 140ms ease-out | S2 adds z/motion tokens (pending D2)
.signals-tr | transition | background-color 140ms ease-out | S2 adds z/motion tokens (pending D2)
@media (prefers-reduced-motion: no-preference) .signals-resting .signals-braille-dot | animation | signals-calm-wave 4.8s ease-in-out infinite | S2 adds z/motion tokens (pending D2)
### app/src/renderer/terminal-tabs.css
#new-tab | transition | background-color 140ms ease-out, color 140ms ease-out | S2 adds z/motion tokens (pending D2)
.activity-indicator-dot | animation | activity-indicator-clockwise 1s linear infinite | S2 adds z/motion tokens (pending D2)
.activity-indicator-dot:nth-child(2) | animation-delay | -833ms | S2 adds z/motion tokens (pending D2)
.activity-indicator-dot:nth-child(3) | animation-delay | -167ms | S2 adds z/motion tokens (pending D2)
.activity-indicator-dot:nth-child(4) | animation-delay | -667ms | S2 adds z/motion tokens (pending D2)
.activity-indicator-dot:nth-child(5) | animation-delay | -333ms | S2 adds z/motion tokens (pending D2)
.activity-indicator-dot:nth-child(6) | animation-delay | -500ms | S2 adds z/motion tokens (pending D2)
.activity-indicator-label | animation | activity-indicator-label-breathe 1.8s ease-in-out infinite | S2 adds z/motion tokens (pending D2)
.activity-indicator[data-variant="attention"] .activity-indicator-dot | animation | activity-indicator-attention-color 1.8s ease-in-out infinite | S2 adds z/motion tokens (pending D2)
.activity-indicator[data-variant="attention"] .activity-indicator-dot:nth-child(1) | animation-delay | -0.9s | S2 adds z/motion tokens (pending D2)
.activity-indicator[data-variant="attention"] .activity-indicator-dot:nth-child(2), .activity-indicator[data-variant="attention"] .activity-indicator-dot:nth-child(3) | animation-delay | -0.6s | S2 adds z/motion tokens (pending D2)
.activity-indicator[data-variant="attention"] .activity-indicator-dot:nth-child(4), .activity-indicator[data-variant="attention"] .activity-indicator-dot:nth-child(5) | animation-delay | -0.3s | S2 adds z/motion tokens (pending D2)
.activity-indicator[data-variant="waiting"] .activity-indicator-dot | animation | activity-indicator-waiting 0.9s ease-in-out infinite | S2 adds z/motion tokens (pending D2)
.tab | transition | opacity 140ms ease-out, background-color 140ms ease-out, color 140ms ease-out | S2 adds z/motion tokens (pending D2)
.tab-close | transition | opacity 140ms ease-out, background-color 140ms ease-out | S2 adds z/motion tokens (pending D2)
.tab-group-toggle | transition | background-color 140ms ease-out, color 140ms ease-out | S2 adds z/motion tokens (pending D2)
### app/src/renderer/terminal-well.css
.term-scrollbar-thumb | transition | background-color 140ms ease-out, width 140ms ease-out | S2 adds z/motion tokens (pending D2)
@media (prefers-reduced-motion: no-preference) .term-holder[data-reveal]::after | animation | term-reveal-pulse 1.4s ease-out 1 forwards | S2 adds z/motion tokens (pending D2)
### app/src/renderer/toast.css
.toast | transition | opacity 150ms ease-out, transform 150ms ease-out | S2 adds z/motion tokens (pending D2)
.toast.leaving | transition-duration | 120ms | S2 adds z/motion tokens (pending D2)
### app/src/renderer/viewer/viewer.css
.viewer-pdf-canvas | transition | opacity 150ms ease-out | S2 adds z/motion tokens (pending D2)
### extension/src/widget.styles.ts
.vg-agent__option | transition | background-color 140ms ease-out, color 140ms ease-out | S2 adds z/motion tokens (pending D2)
.vg-btn | transition | background-color 140ms ease-out, color 140ms ease-out | S2 adds z/motion tokens (pending D2)
.vg-card | animation | vg-rise 150ms ease-out | S2 adds z/motion tokens (pending D2)
.vg-close | transition | background-color 140ms ease-out, color 140ms ease-out | S2 adds z/motion tokens (pending D2)
.vg-dot--pulse | animation | vg-pulse 1.6s ease-in-out infinite | S2 adds z/motion tokens (pending D2)
.vg-model__chevron | transition | transform 120ms ease-out | S2 adds z/motion tokens (pending D2)
.vg-model__menu--down | animation | vg-menu-down 120ms ease-out | S2 adds z/motion tokens (pending D2)
.vg-model__menu--up | animation | vg-menu-up 120ms ease-out | S2 adds z/motion tokens (pending D2)
.vg-model__trigger | transition | border-color 140ms ease-out | S2 adds z/motion tokens (pending D2)
.vg-pill | transition | background-color 140ms ease-out, border-color 140ms ease-out, transform 140ms ease-out | S2 adds z/motion tokens (pending D2)
.vg-pr | transition | background-color 140ms ease-out | S2 adds z/motion tokens (pending D2)

## raw-easing
### app/src/renderer/agent-dock/agent-dock.css
.agent-dock-agent-glyph[data-tone="working"] | animation | agent-dock-pulse 1.6s ease-in-out infinite | S2 adds z/motion tokens (pending D2)
.agent-dock-agent::before | transition | background-color 140ms ease-out | S2 adds z/motion tokens (pending D2)
.agent-dock-agents-n | transition | color 140ms ease-out | S2 adds z/motion tokens (pending D2)
.agent-dock-choice | transition | background-color 140ms ease-out | S2 adds z/motion tokens (pending D2)
.agent-dock-entry, .agent-dock-more, .agent-dock-agents-entry | transition | background-color 140ms ease-out | S2 adds z/motion tokens (pending D2)
.agent-dock-entry-name | transition | color 140ms ease-out | S2 adds z/motion tokens (pending D2)
.agent-dock-group-option | transition | color 140ms ease-out | S2 adds z/motion tokens (pending D2)
.agent-dock-prompt | transition | border-color 140ms ease-out | S2 adds z/motion tokens (pending D2)
.agent-dock-qtab | transition | color 140ms ease-out | S2 adds z/motion tokens (pending D2)
.agent-dock-reveal-link | transition | color 140ms ease-out, text-decoration-color 140ms ease-out | S2 adds z/motion tokens (pending D2)
.agent-dock-title-btn | transition | background-color 140ms ease-out, color 140ms ease-out | S2 adds z/motion tokens (pending D2)
.agent-dock::before | transition | background-color 140ms ease-out | S2 adds z/motion tokens (pending D2)
@media (prefers-reduced-motion: no-preference) .agent-dock-row [data-arrival] | animation | agent-dock-arrival-fill 1.4s ease-out 1 | S2 adds z/motion tokens (pending D2)
@media (prefers-reduced-motion: no-preference) .agent-dock:has(.agent-dock-row [data-arrival="turn"])::before | animation | agent-dock-arrival-edge-accent 1.4s ease-out 1 | S2 adds z/motion tokens (pending D2)
@media (prefers-reduced-motion: no-preference) .agent-dock:has(.agent-dock-row [data-arrival]:not([data-arrival="turn"]))::before | animation | agent-dock-arrival-edge-warn 1.4s ease-out 1 | S2 adds z/motion tokens (pending D2)
### app/src/renderer/background-terminals.css
#bg-toggle | transition | transform 140ms ease-out, background-color 140ms ease-out, color 140ms ease-out | S2 adds z/motion tokens (pending D2)
.bg-group-header-row | transition | background-color 140ms ease-out | S2 adds z/motion tokens (pending D2)
.bg-row | transition | background-color 140ms ease-out | S2 adds z/motion tokens (pending D2)
### app/src/renderer/button.css
.btn | transition | background-color 140ms ease-out, color 140ms ease-out | S2 adds z/motion tokens (pending D2)
### app/src/renderer/document-review/document-review.css
.review-screenshot-remove | transition | opacity 120ms ease-out | S2 adds z/motion tokens (pending D2)
### app/src/renderer/panes.css
#divider | transition | background-color 120ms ease-out | S2 adds z/motion tokens (pending D2)
### app/src/renderer/remote/remote.css
.remote-back::before | transition | background-color 140ms ease-out | S2 adds z/motion tokens (pending D2)
.remote-composer-actions .menu-panel | animation | remote-popover-in 140ms ease-out both | S2 adds z/motion tokens (pending D2)
.remote-information-view | animation | remote-reading-view-in 160ms ease-out both | S2 adds z/motion tokens (pending D2)
.remote-navigation-dismiss | animation | remote-scrim-in 160ms ease-out both | S2 adds z/motion tokens (pending D2)
.remote-navigation-item | transition | background-color 140ms ease-out, color 140ms ease-out | S2 adds z/motion tokens (pending D2)
.remote-navigation-menu | animation | remote-navigation-in 180ms cubic-bezier(0.22, 1, 0.36, 1) both | S2 adds z/motion tokens (pending D2)
.remote-navigation-trigger::before | transition | background-color 140ms ease-out | S2 adds z/motion tokens (pending D2)
.remote-row-menu | animation | remote-popover-in 140ms ease-out both | S2 adds z/motion tokens (pending D2)
.remote-sheet | animation | remote-sheet-in 180ms cubic-bezier(0.22, 1, 0.36, 1) both | S2 adds z/motion tokens (pending D2)
.remote-sheet-dismiss | animation | remote-scrim-in 160ms ease-out both | S2 adds z/motion tokens (pending D2)
.remote-sheet-option | transition | background-color 140ms ease-out, color 140ms ease-out | S2 adds z/motion tokens (pending D2)
.remote-usage | animation | remote-reading-view-in 160ms ease-out both | S2 adds z/motion tokens (pending D2)
@media (min-width: 1200px) .remote-information-rail | animation | remote-rail-in 160ms ease-out both | S2 adds z/motion tokens (pending D2)
### app/src/renderer/sidebar/sidebar.css
.action-row::after | transition | opacity 140ms ease-out | S2 adds z/motion tokens (pending D2)
.attachment-row | transition | background-color 140ms ease-out | S2 adds z/motion tokens (pending D2)
.clamp-cue | transition | color 140ms ease-out | S2 adds z/motion tokens (pending D2)
.dot-pulse | animation | dot-pulse 1.6s ease-in-out infinite | S2 adds z/motion tokens (pending D2)
.field-reset | transition | color 140ms ease-out | S2 adds z/motion tokens (pending D2)
.icon-btn | transition | background-color 140ms ease-out, color 140ms ease-out | S2 adds z/motion tokens (pending D2)
.input | transition | border-color 140ms ease-out | S2 adds z/motion tokens (pending D2)
.item-row | transition | background-color 140ms ease-out | S2 adds z/motion tokens (pending D2)
.menu-panel | animation | menu-in 120ms ease-out | S2 adds z/motion tokens (pending D2)
.nav-pop-out | animation | nav-out 120ms ease-out forwards | S2 adds z/motion tokens (pending D2)
.nav-push-in | animation | nav-in 150ms ease-out | S2 adds z/motion tokens (pending D2)
.nav-under-away | animation | nav-under-away 150ms ease-out | S2 adds z/motion tokens (pending D2)
.nav-under-back | animation | nav-under-back 120ms ease-out | S2 adds z/motion tokens (pending D2)
.new-item-prompt-field::before | transition | background-color 140ms ease-out | S2 adds z/motion tokens (pending D2)
.project-trigger | transition | background-color 140ms ease-out, color 140ms ease-out | S2 adds z/motion tokens (pending D2)
.segment | transition | background-color 140ms ease-out, color 140ms ease-out | S2 adds z/motion tokens (pending D2)
.sheet | animation | sheet-in 150ms ease-out | S2 adds z/motion tokens (pending D2)
.sheet-scrim | animation | scrim-in 150ms ease-out | S2 adds z/motion tokens (pending D2)
.task-metadata summary::after | transition | transform 140ms ease-out | S2 adds z/motion tokens (pending D2)
.toggle | transition | background-color 140ms ease-out, border-color 140ms ease-out | S2 adds z/motion tokens (pending D2)
.toggle-knob | transition | transform 140ms ease-out | S2 adds z/motion tokens (pending D2)
### app/src/renderer/signals/signals.css
.signals-list-btn | transition | color 140ms ease-out | S2 adds z/motion tokens (pending D2)
.signals-tr | transition | background-color 140ms ease-out | S2 adds z/motion tokens (pending D2)
@media (prefers-reduced-motion: no-preference) .signals-resting .signals-braille-dot | animation | signals-calm-wave 4.8s ease-in-out infinite | S2 adds z/motion tokens (pending D2)
### app/src/renderer/terminal-tabs.css
#new-tab | transition | background-color 140ms ease-out, color 140ms ease-out | S2 adds z/motion tokens (pending D2)
.activity-indicator-dot | animation | activity-indicator-clockwise 1s linear infinite | S2 adds z/motion tokens (pending D2)
.activity-indicator-label | animation | activity-indicator-label-breathe 1.8s ease-in-out infinite | S2 adds z/motion tokens (pending D2)
.activity-indicator[data-variant="attention"] .activity-indicator-dot | animation | activity-indicator-attention-color 1.8s ease-in-out infinite | S2 adds z/motion tokens (pending D2)
.activity-indicator[data-variant="waiting"] .activity-indicator-dot | animation | activity-indicator-waiting 0.9s ease-in-out infinite | S2 adds z/motion tokens (pending D2)
.tab | transition | opacity 140ms ease-out, background-color 140ms ease-out, color 140ms ease-out | S2 adds z/motion tokens (pending D2)
.tab-close | transition | opacity 140ms ease-out, background-color 140ms ease-out | S2 adds z/motion tokens (pending D2)
.tab-group-toggle | transition | background-color 140ms ease-out, color 140ms ease-out | S2 adds z/motion tokens (pending D2)
### app/src/renderer/terminal-well.css
.term-scrollbar-thumb | transition | background-color 140ms ease-out, width 140ms ease-out | S2 adds z/motion tokens (pending D2)
@media (prefers-reduced-motion: no-preference) .term-holder[data-reveal]::after | animation | term-reveal-pulse 1.4s ease-out 1 forwards | S2 adds z/motion tokens (pending D2)
### app/src/renderer/toast.css
.toast | transition | opacity 150ms ease-out, transform 150ms ease-out | S2 adds z/motion tokens (pending D2)
### app/src/renderer/toast.ts
countdownEl.style in showToast | transition | transform var(--expr)ms linear | S2 adds z/motion tokens (pending D2)
### app/src/renderer/viewer/viewer.css
.viewer-grid-letter, .viewer-grid-number | transition | color var(--motion-state, 140ms) ease-out | S2 adds z/motion tokens (pending D2)
.viewer-pdf-canvas | transition | opacity 150ms ease-out | S2 adds z/motion tokens (pending D2)
### extension/src/widget.styles.ts
.vg-agent__option | transition | background-color 140ms ease-out, color 140ms ease-out | S2 adds z/motion tokens (pending D2)
.vg-btn | transition | background-color 140ms ease-out, color 140ms ease-out | S2 adds z/motion tokens (pending D2)
.vg-card | animation | vg-rise 150ms ease-out | S2 adds z/motion tokens (pending D2)
.vg-close | transition | background-color 140ms ease-out, color 140ms ease-out | S2 adds z/motion tokens (pending D2)
.vg-dot--pulse | animation | vg-pulse 1.6s ease-in-out infinite | S2 adds z/motion tokens (pending D2)
.vg-model__chevron | transition | transform 120ms ease-out | S2 adds z/motion tokens (pending D2)
.vg-model__menu--down | animation | vg-menu-down 120ms ease-out | S2 adds z/motion tokens (pending D2)
.vg-model__menu--up | animation | vg-menu-up 120ms ease-out | S2 adds z/motion tokens (pending D2)
.vg-model__trigger | transition | border-color 140ms ease-out | S2 adds z/motion tokens (pending D2)
.vg-pill | transition | background-color 140ms ease-out, border-color 140ms ease-out, transform 140ms ease-out | S2 adds z/motion tokens (pending D2)
.vg-pr | transition | background-color 140ms ease-out | S2 adds z/motion tokens (pending D2)

## radius-off-scale
### app/src/renderer/agent-dock/agent-dock.css
.agent-dock-agents-seg | border-radius | 1.5px | D8 off-scale values
.agent-dock-choices[data-multi="true"] .agent-dock-choice-cursor | border-radius | 3px | D8 off-scale values
### app/src/renderer/remote/remote.css
.remote-compose-surface | border-radius | 28px | D8 off-scale values
.remote-composer-actions .menu-item | border-radius | 12px | D8 off-scale values
.remote-composer-actions .menu-panel | border-radius | 18px | D8 off-scale values
.remote-information-body dl | border-radius | 12px | D8 off-scale values
.remote-message[data-role="user"] .remote-user-text | border-radius | 18px | D8 off-scale values
.remote-navigation-item | border-radius | 12px | D8 off-scale values
.remote-sheet | border-radius | 24px | D8 off-scale values
.remote-workspace input:not([type="radio"]):not([type="checkbox"]), .remote-workspace select, .remote-workspace textarea, .remote-login input | border-radius | 10px | D8 off-scale values
### app/src/renderer/sidebar/sidebar.css
.color-input::-webkit-color-swatch | border-radius | 3px | D8 off-scale values
.new-item-prompt-field::before | border-radius | 1px | D8 off-scale values
.segmented-index .segment-active .segment-body::after | border-radius | 1px | D8 off-scale values
### app/src/renderer/viewer/viewer.css
.viewer-code .cm-editor .cm-searchMatch | border-radius | 2px | D8 off-scale values
.viewer-pdf-paper | border-radius | 2px | D8 off-scale values
### extension/src/popup.html
input | border-radius | 3px | D9 extension popup (moves onto Helm tokens)

## spacing-off-scale
### app/src/renderer/agent-dock/agent-dock.css
.agent-dock-agent-age | padding-left | 6px | D8 off-scale values
.agent-dock-agents-bar | gap | 2px | D8 off-scale values
.agent-dock-agents-bar | margin-left | 5px | D8 off-scale values
.agent-dock-entry-line | gap | 6px | D8 off-scale values
.agent-dock-md :is(ul, ol) | padding-left | 18px | D8 off-scale values
.agent-dock-md blockquote | padding-left | 18px | D8 off-scale values
.agent-dock-md li | padding-left | 2px | D8 off-scale values
.agent-dock-md li + li, .agent-dock-md li > :is(ul, ol), .agent-dock-md li > p + * | margin-top | 2px | D8 off-scale values
.agent-dock-md p + :is(ul, ol) | margin-top | 2px | D8 off-scale values
.agent-dock-source | gap | 6px | D8 off-scale values
.agent-dock-source + .agent-dock-source::before | margin-right | 2px | D8 off-scale values
### app/src/renderer/background-terminals.css
#bg-toggle | gap | 6px | D8 off-scale values
#bg-toggle:has(> .bg-current:not([hidden])):not(.drag-ready, .drag-over) | padding | 0 8px 0 10px | D8 off-scale values
.bg-count | padding | 2px 7px | D8 off-scale values
### app/src/renderer/button.css
.btn | gap | 6px | D8 off-scale values
.btn | padding | 0 14px | D8 off-scale values
.btn-sm | padding | 0 10px | D8 off-scale values
### app/src/renderer/document-review/document-review.css
.review-header | padding | 8px 16px 8px 90px | D8 off-scale values
.review-header-controls > .btn | gap | 6px | D8 off-scale values
.review-image-note | padding | 8px 10px | D8 off-scale values
.review-reading | padding | 20px 40px 80px 32px | D8 off-scale values
.review-screenshots | margin | 0 0 10px | D8 off-scale values
.review-screenshots | padding | 2px | D8 off-scale values
.review-send-refused | column-gap | 6px | D8 off-scale values
@media (max-width: 900px) .review-header | padding-left | 90px | D8 off-scale values
@media (max-width: 900px) .review-reading | padding-inline | 24px 40px | D8 off-scale values
### app/src/renderer/no-terminals.css
.no-terms-detail | margin-top | 6px | D8 off-scale values
.no-terms-detail kbd | padding | 1px 5px | D8 off-scale values
### app/src/renderer/remote/remote.css
.remote-chat > .remote-header | margin-bottom | calc(-44px - env(safe-area-inset-top, 0px)) | D8 off-scale values
.remote-chat > .remote-header + .remote-reading-stage > .remote-reading-area > .remote-transcript | padding-top | calc(68px + env(safe-area-inset-top, 0px)) | D8 off-scale values
.remote-chat > .remote-header + :is(.remote-notice, .remote-history) | margin-top | calc(44px + env(safe-area-inset-top, 0px)) | D8 off-scale values
.remote-composer-actions | padding | 6px | D8 off-scale values
.remote-composer-actions .menu-panel | padding | 6px | D8 off-scale values
.remote-information h3 | padding-left | 2px | D8 off-scale values
.remote-information-body dl > div | padding | 11px 16px | D8 off-scale values
.remote-markdown code | padding | 2px 4px | D8 off-scale values
.remote-markdown p | margin | 0 0 10px | D8 off-scale values
.remote-message | padding | 10px 0 | D8 off-scale values
.remote-message[data-role="user"] .remote-user-text | padding | 8px 14px | D8 off-scale values
.remote-navigation-header | padding | 6px 16px | D8 off-scale values
.remote-scope-filter select | padding | 6px 8px !important | D8 off-scale values
.remote-session-info-detail | gap | 6px | D8 off-scale values
.remote-sheet | padding | 18px 0 max(12px, env(safe-area-inset-bottom, 0px)) | D8 off-scale values
.remote-sheet-title | padding | 10px 20px 12px | D8 off-scale values
.remote-transcript | padding | 24px 16px calc(28px + var(--remote-composer-overlap, 76px)) | D8 off-scale values
.remote-usage-plan | padding | 1px 6px | D8 off-scale values
.remote-workspace .remote-compose-open textarea | padding | 8px 12px 2px | D8 off-scale values
.remote-workspace .remote-compose-surface textarea | padding | 10px 6px | D8 off-scale values
### app/src/renderer/run-context/run-context-editor.css
.run-context-banner | padding | 10px 24px | D8 off-scale values
.run-context-banner > div | gap | 2px | D8 off-scale values
.run-context-dialog | padding | 22px 24px | D8 off-scale values
.run-context-dialog p, .run-context-start-state p | margin | 8px 0 22px | D8 off-scale values
.run-context-editor | padding | 28px max(36px, calc((100% - 760px) / 2)) | D8 off-scale values
.run-context-header | padding | 0 16px 0 84px | D8 off-scale values
.run-context-kicker | margin-bottom | 2px | D8 off-scale values
.run-context-notice | padding | 9px 24px | D8 off-scale values
.run-context-save-state | gap | 7px | D8 off-scale values
.run-context-source dl > div | gap | 2px | D8 off-scale values
.run-context-source dl, .run-context-source ul | gap | 10px | D8 off-scale values
.run-context-source h2 | margin | 0 0 10px | D8 off-scale values
### app/src/renderer/sidebar/detail-redesign.css
.activity-history | gap | 10px | D8 off-scale values
.activity-list | gap | 5px | D8 off-scale values
.command-status | gap | 7px | D8 off-scale values
.detail-hero | gap | 5px | D8 off-scale values
[data-detail-state] .card | gap | 10px | D8 off-scale values
### app/src/renderer/sidebar/scheduled-runs.css
.scheduled-history-row | padding | 10px 0 | D8 off-scale values
### app/src/renderer/sidebar/sidebar.css
.banner | padding | 10px 12px | D8 off-scale values
.card | gap | 10px | D8 off-scale values
.card-flush .card-head | margin-bottom | 6px | D8 off-scale values
.chip | padding | 2px 8px | §9 ruling 26 chip padding 2×8
.color-input::-webkit-color-swatch-wrapper | padding | 3px | D8 off-scale values
.empty-detail | margin-top | 6px | D8 off-scale values
.input | padding | 0 10px | D8 off-scale values
.intent-questions | gap | 6px | D8 off-scale values
.item-project-group + .item-project-group | margin-top | 6px | D8 off-scale values
.item-row-actions | gap | 2px | D8 off-scale values
.item-row-shell-actions .item-row | padding-right | 84px | D8 off-scale values
.item-row-status | gap | 5px | D8 off-scale values
.list-scroll | padding | 6px 0 16px | D8 off-scale values
.list-toolbar | padding | 10px 8px 0 | D8 off-scale values
.log-well | padding | 10px 12px | D8 off-scale values
.menu-trigger-badge | padding | 2px 8px | §9 ruling 26 chip padding 2×8
.plan-well | padding | 10px 12px | D8 off-scale values
.remote-device-state | margin-top | 2px | D8 off-scale values
.run-caption | margin-top | 6px | D8 off-scale values
.security-note | padding | 10px 12px | D8 off-scale values
.segmented-index .segment-body | gap | 6px | D8 off-scale values
.select | padding-right | 28px | D8 off-scale values
.sheet-heading | padding-top | 2px | D8 off-scale values
.shortcut-alias button | padding | 0 6px | D8 off-scale values
.shortcut-scope | margin | 14px 0 0 | D8 off-scale values
.shortcut-title | gap | 2px | D8 off-scale values
.task-image-caption | padding | 8px 10px | D8 off-scale values
.textarea | padding | 8px 10px | D8 off-scale values
### app/src/renderer/signals/signals.css
.signals-braille | margin-bottom | 14px | D8 off-scale values
.signals-braille-cell | gap | 5px | D8 off-scale values
.signals-braille-mark .signals-braille-cell | gap | 2px | D8 off-scale values
.signals-choice-label .signals-glyph | margin-right | 6px | D8 off-scale values
.signals-choice-label.signals-ask-link | padding-block | 5px | D8 off-scale values
.signals-foot | padding | 8px 16px 10px | D8 off-scale values
.signals-foot-hints | gap | 2px 14px | D8 off-scale values
.signals-resting | gap | 6px | D8 off-scale values
.signals-section + .signals-section | margin-top | 28px | D8 off-scale values
.signals-section .signals-tr | scroll-margin-top | 28px | D8 off-scale values
### app/src/renderer/terminal-tabs.css
#tabs | margin-left | -6px | D8 off-scale values
#tabs | padding-left | 6px | D8 off-scale values
.activity-indicator | gap | 2px | D8 off-scale values
.tab | padding | 0 6px 0 10px | D8 off-scale values
.tab-group-summary | gap | 5px | D8 off-scale values
.tab-rename | padding | 0 6px | D8 off-scale values
.tab-running | margin-right | 2px | D8 off-scale values
### app/src/renderer/terminal-well.css
.term-holder | padding | 14px 0 14px 16px | D8 off-scale values
### app/src/renderer/toast.css
#toasts | gap | 6px | D8 off-scale values
.toast | gap | 10px | D8 off-scale values
.toast | padding | 11px 12px 13px | D8 off-scale values
.toast-action | margin | -3px 0 0 0 | D8 off-scale values
.toast-dismiss | margin | -3px -6px 0 -6px | D8 off-scale values
### app/src/renderer/topbar.css
.topbar-left | padding-left | 84px | D8 off-scale values
.topbar-right | padding | 0 10px 0 6px | D8 off-scale values
### app/src/renderer/viewer/viewer.css
.viewer-code .cm-editor .cm-panel .cm-textfield, .viewer-search-field | padding | 0 10px | D8 off-scale values
.viewer-code .cm-editor .cm-panel.cm-search | padding | 8px 48px 8px 16px | D8 off-scale values
.viewer-pdf-outline-item | padding | 7px 12px 7px 16px | D8 off-scale values
.viewer-pdf-password | margin | 48px auto | D8 off-scale values
.viewer-tree-colon | margin-inline-start | -6px | D8 off-scale values
.viewer-tree-row | gap | 6px | D8 off-scale values
### extension/src/popup.html
.models .group | margin | 8px 0 2px | D9 extension popup (moves onto Helm tokens)
.models .row | gap | 6px | D9 extension popup (moves onto Helm tokens)
.models .row | padding | 2px 0 | D9 extension popup (moves onto Helm tokens)
.status | margin-top | 10px | D9 extension popup (moves onto Helm tokens)
h1 | margin | 0 0 14px 0 | D9 extension popup (moves onto Helm tokens)
input | padding | 6px 8px | D9 extension popup (moves onto Helm tokens)
### extension/src/widget.styles.ts
.vg-chip | padding | 2px 8px | §9 ruling 26 chip padding 2×8
.vg-error | padding | 10px 12px | D8 off-scale values
.vg-model__trigger | padding | 0 10px | D8 off-scale values
.vg-run-context | padding-top | 10px | D8 off-scale values
.vg-run-context__header | margin-bottom | 6px | D8 off-scale values
.vg-run-menu input | padding | 6px | D8 off-scale values

## font-size-off-scale
### app/src/renderer/agent-dock/agent-dock.css
.agent-dock-message-mark | font-size | calc(9px * var(--ui-scale)) | D8 off-scale values
### app/src/renderer/background-terminals.css
.bg-action-glyph | font-size | 16px | D8 off-scale values
.bg-count | font-size | 10px | D8 off-scale values
.bg-kill-glyph | font-size | 14px | D8 off-scale values
### app/src/renderer/reading-width.css
[data-reading-width] :not(pre) > code | font-size | 0.92em | D8 off-scale values
### app/src/renderer/remote/remote.css
.remote-composer-actions .menu-item | font-size | calc(14px * var(--ui-scale, 1)) | D8 off-scale values
.remote-markdown code | font-size | 0.92em | D8 off-scale values
.remote-markdown h3 | font-size | calc(20px * var(--ui-scale, 1)) | D8 off-scale values
.remote-message | font-size | calc(16px * var(--ui-scale, 1)) | D8 off-scale values
.remote-navigation-conversation-title | font-size | calc(14px * var(--ui-scale, 1)) | D8 off-scale values
.remote-navigation-item | font-size | calc(16px * var(--ui-scale, 1)) | D8 off-scale values
.remote-session-title | font-size | calc(16px * var(--ui-scale, 1)) | D8 off-scale values
.remote-sheet-option | font-size | calc(16px * var(--ui-scale, 1)) | D8 off-scale values
.remote-sheet-title | font-size | calc(16px * var(--ui-scale, 1)) | D8 off-scale values
@media (max-width: 799px) .remote-workspace input:not([type="radio"]):not([type="checkbox"]), .remote-workspace select, .remote-workspace textarea, .remote-login input | font-size | 16px | §9 ruling 58 Remote web 16px form text
### app/src/renderer/run-context/run-context-editor.css
.run-context-dialog h2, .run-context-start-state h1 | font-size | calc(15px * var(--ui-scale)) | D8 off-scale values
.run-context-editor .bn-editor | font-size | calc(14px * var(--ui-scale)) | D8 off-scale values
.run-context-heading h1 | font-size | calc(14px * var(--ui-scale)) | D8 off-scale values
.run-context-kicker | font-size | calc(10px * var(--ui-scale)) | D8 off-scale values
.run-context-source dt | font-size | calc(10px * var(--ui-scale)) | D8 off-scale values
### app/src/renderer/sidebar/sidebar.css
.item-project-group-head > span:last-child | font-size | calc(10px * var(--ui-scale)) | D8 off-scale values
.menu-item-color | font-size | calc(14px * var(--ui-scale)) | D8 off-scale values
.question-mark | font-size | calc(10px * var(--ui-scale)) | D8 off-scale values
### app/src/renderer/terminal-tabs.css
#new-tab | font-size | 16px | D8 off-scale values
.tab-group-count | font-size | calc(10px * var(--ui-scale)) | D8 off-scale values
### app/src/renderer/viewer/viewer.css
.viewer-grid-letter, .viewer-grid-number | font-size | 0.92em | D8 off-scale values
.viewer-pdf-password-title | font-size | calc(14px * var(--ui-scale)) | D8 off-scale values
### extension/src/popup.html
h1 | font-size | 14px | D9 extension popup (moves onto Helm tokens)
### extension/src/widget.styles.ts
.vg-close | font-size | 16px | D8 off-scale values
.vg-error__dismiss | font-size | 16px | D8 off-scale values

## font-size-unscaled
### app/src/renderer/sidebar/sidebar.css
.menu-item .menu-hint | font-size | 11px | D13 unscaled sidebar type

## letter-spacing
### app/src/renderer/agent-dock/agent-dock.css
.agent-dock-hint kbd[data-face="symbols"] | letter-spacing | 0.04em | D8 off-scale values (letter-spacing overrides)
.agent-dock-kbd | letter-spacing | 0.04em | D8 off-scale values (letter-spacing overrides)
.agent-dock-title-hint kbd[data-face="symbols"] | letter-spacing | 0.04em | D8 off-scale values (letter-spacing overrides)
### app/src/renderer/sidebar/sidebar.css
.remote-code | letter-spacing | 0.08em | D8 off-scale values (letter-spacing overrides)

## font-weight
### app/src/renderer/background-terminals.css
.bg-count | font-weight | 700 | D8 off-scale values (weights 650/700)
### app/src/renderer/document-review/document-review.css
.review-send-refused-glyph | font-weight | 700 | D8 off-scale values (weights 650/700)
### app/src/renderer/sidebar/sidebar.css
.question-mark | font-weight | 700 | D8 off-scale values (weights 650/700)
### extension/src/widget.styles.ts
.vg-model__trigger | font-weight | 650 | D8 off-scale values (weights 650/700)

## inline-svg
### app/src/renderer/index.html
html | markup | <svg viewBox="0 0 16 16"> | §9 ruling 54: static first-paint copy of the icon module's backgroundStack, held equal by tests/design-icons.test.ts
### app/src/renderer/sidebar/sidebar.css
.select | background-image | url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' … #b8a367f3 | D6 hand-drawn icons (a CSS data URI, listed in ICONS_OUTSIDE_MODULE)
### extension/src/Widget.tsx
in ModelSelect | jsx | <svg viewBox="0 0 10 6"> | D6 hand-drawn icons (D1: the SolidJS extension keeps its own icons)
in ModelSelect | jsx | <svg viewBox="0 0 10 8"> | D6 hand-drawn icons (D1: the SolidJS extension keeps its own icons)
`

export const DESIGN_LINT_ALLOWLIST: readonly AllowlistEntry[] = parseBaseline(DESIGN_LINT_BASELINE)
