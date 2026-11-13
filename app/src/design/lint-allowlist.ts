// Design lint baseline: every finding of app/src/design/lint.ts that is allowed to stay, with the decision
// (docs/plans/design-system/spec.md D<n>), ruling (docs/design-system.md §9 ruling N) or plan stage (S<n>) that
// keeps it. tests/design-lint.test.ts fails on a finding missing here, on an entry with no finding left (the
// value was fixed: remove it), on a `TODO:` reason and on a rule count above its cap. Regenerate with
// `node --import tsx app/scripts/design-lint.ts --write-baseline`, which keeps the reasons below for entries
// that still match and refuses new entries unless `--allow-new` is given; edit reasons by hand. Never add an
// entry to let new code through: use a token, or get a ruling first.
//
// Format, under `## <rule>` and `### <file>` headers: <selector> | <property> | <value> | <reason>
import { type AllowlistEntry, parseBaseline } from './lint'

export const DESIGN_LINT_BASELINE = String.raw`
## raw-color
### app/src/renderer/remote/remote.css
.remote-composer-actions .menu-panel | box-shadow | 0 16px 44px rgb(0 0 0 / 48%) | D16 Remote values outside the palette (D7 A settled only the seven surface tokens)
.remote-composer-actions .remote-send.btn-primary | background | #fff | D16 Remote values outside the palette (D7 A settled only the seven surface tokens)
.remote-composer-actions .remote-send.btn-primary | color | #0d0d0d | D16 Remote values outside the palette (D7 A settled only the seven surface tokens)
.remote-navigation-dismiss | background | rgb(0 0 0 / 58%) | D16 Remote values outside the palette (D7 A settled only the seven surface tokens)
.remote-navigation-menu | box-shadow | 20px 0 60px rgb(0 0 0 / 48%) | D16 Remote values outside the palette (D7 A settled only the seven surface tokens)
.remote-row-menu | box-shadow | 0 8px 24px rgb(0 0 0 / 35%) | D16 Remote values outside the palette (D7 A settled only the seven surface tokens)
.remote-sheet | box-shadow | 0 20px 60px rgb(0 0 0 / 55%) | D16 Remote values outside the palette (D7 A settled only the seven surface tokens)
.remote-sheet-dismiss | background | rgb(0 0 0 / 58%) | D16 Remote values outside the palette (D7 A settled only the seven surface tokens)
@media (hover: hover) .remote-composer-actions .remote-send.btn-primary:hover:not(:disabled), .remote-composer-actions .remote-send.btn-primary[data-force-state="hover"]:not(:disabled) | background | rgb(255 255 255 / 88%) | D16 Remote values outside the palette (D7 A settled only the seven surface tokens)
### app/src/renderer/viewer/viewer.css
.viewer-pdf-paper | background | #fff | S2 gives the literal a token (§9 ruling 9)

## token-definition
### app/assets/remote/remote-sw.js
:root | --accent | #4c9aff | §9 ruling 96 (the offline page cannot load tokens.css; its colours copy the Helm preset, held by tests/remote-pwa.test.ts)
:root | --pane | #141517 | §9 ruling 96 (the offline page cannot load tokens.css; its colours copy the Helm preset, held by tests/remote-pwa.test.ts)
:root | --text-0 | #ececee | §9 ruling 96 (the offline page cannot load tokens.css; its colours copy the Helm preset, held by tests/remote-pwa.test.ts)
:root | --text-1 | #9a9ea6 | §9 ruling 96 (the offline page cannot load tokens.css; its colours copy the Helm preset, held by tests/remote-pwa.test.ts)
### app/src/renderer/document-review/document-review.css
.document-review[data-review-theme="light"] | --accent | #176ac1 | §2.8 Review light scope (§9 ruling 10; value §9 ruling 94)
.document-review[data-review-theme="light"] | --accent-fill | #176ac1 | §2.8 Review light scope (§9 ruling 10; value §9 ruling 94)
.document-review[data-review-theme="light"] | --accent-fill-hover | #125ba8 | §2.8 Review light scope (§9 ruling 10)
.document-review[data-review-theme="light"] | --chrome | #f1f0ed | §2.8 Review light scope (§9 ruling 10)
.document-review[data-review-theme="light"] | --danger | #b91c1c | §2.8 Review light scope (§9 ruling 10)
.document-review[data-review-theme="light"] | --danger-soft | color-mix(in srgb, var(--danger) 15%, transparent) | §2.8 Review light scope (§9 ruling 10)
.document-review[data-review-theme="light"] | --fill-raised | rgba(0, 0, 0, 0.09) | §2.8 Review light scope (§9 ruling 10)
.document-review[data-review-theme="light"] | --fill-strong | rgba(0, 0, 0, 0.13) | §2.8 Review light scope (§9 ruling 10)
.document-review[data-review-theme="light"] | --fill-subtle | rgba(0, 0, 0, 0.05) | §2.8 Review light scope (§9 ruling 10)
.document-review[data-review-theme="light"] | --hairline | rgba(0, 0, 0, 0.07) | §2.8 Review light scope (§9 ruling 10)
.document-review[data-review-theme="light"] | --hairline-strong | rgba(0, 0, 0, 0.16) | §2.8 Review light scope (§9 ruling 10)
.document-review[data-review-theme="light"] | --neutral | #656a73 | §2.8 Review light scope (§9 ruling 10; value §9 ruling 94)
.document-review[data-review-theme="light"] | --neutral-soft | color-mix(in srgb, var(--neutral) 15%, transparent) | §2.8 Review light scope (§9 ruling 10): the soft fill recomputed from the scope's --neutral (§9 ruling 94)
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
### app/src/renderer/viewer/viewer.css
.viewer-stage | --ui-scale | calc(var(--review-ui-scale) * var(--review-zoom, 1)) | D7 surface reach (Review keeps its own text scale)

## raw-z-index
### app/src/renderer/agent-dock/agent-dock.css
.agent-dock-agent::before | z-index | -1 | S2 adds z/motion tokens
.agent-dock-resize | z-index | 3 | S2 adds z/motion tokens
.agent-dock::before | z-index | 1 | S2 adds z/motion tokens
### app/src/renderer/document-review/document-review.css
.review-selection-actions | z-index | 3 | S2 adds z/motion tokens
### app/src/renderer/no-terminals.css
#no-terms | z-index | 2 | S2 adds z/motion tokens
### app/src/renderer/remote/remote.css
.remote-back::before | z-index | -1 | S2 adds z/motion tokens
.remote-chat > .remote-header | z-index | 4 | S2 adds z/motion tokens
.remote-compose-surface::before | z-index | -1 | S2 adds z/motion tokens
.remote-composer | z-index | 3 | S2 adds z/motion tokens
.remote-information-view | z-index | 10 | S2 adds z/motion tokens
.remote-jump | z-index | 2 | S2 adds z/motion tokens
.remote-navigation-scrim | z-index | 70 | S2 adds z/motion tokens
.remote-navigation-trigger::before | z-index | -1 | S2 adds z/motion tokens
.remote-row-menu | z-index | 2 | S2 adds z/motion tokens
.remote-sheet-scrim | z-index | 60 | S2 adds z/motion tokens
### app/src/renderer/sidebar/sidebar.css
.action-bar | z-index | 10 | S2 adds z/motion tokens
.action-row::after | z-index | -1 | S2 adds z/motion tokens
.menu-panel | z-index | 40 | S2 adds z/motion tokens
.push-header | z-index | 10 | S2 adds z/motion tokens
.sheet | z-index | 1 | S2 adds z/motion tokens
.sheet-layer | z-index | 60 | S2 adds z/motion tokens
.sheet-scrim | z-index | 0 | S2 adds z/motion tokens
.swipe-scrim | z-index | 30 | S2 adds z/motion tokens
### app/src/renderer/signals/signals.css
.signals-band | z-index | 1 | S2 adds z/motion tokens
### app/src/renderer/terminal-context-menu.css
.menu-panel.menu-fixed | z-index | 40 | S2 adds z/motion tokens
### app/src/renderer/terminal-tabs.css
.tab-drag-preview | z-index | 60 | S2 adds z/motion tokens
.tab-group-drag-preview | z-index | 60 | S2 adds z/motion tokens
### app/src/renderer/terminal-well.css
.term-holder[data-reveal]::after | z-index | 9 | S2 adds z/motion tokens
.term-mount .term-frame-freeze | z-index | 8 | S2 adds z/motion tokens
.term-scrollbar | z-index | 2 | S2 adds z/motion tokens
### app/src/renderer/toast.css
#toasts | z-index | 100 | S2 adds z/motion tokens
### app/src/renderer/viewer/viewer.css
.viewer-grid-band | z-index | 3 | S2 adds z/motion tokens
.viewer-grid-band > .viewer-grid-number | z-index | 2 | S2 adds z/motion tokens
.viewer-grid-cells | z-index | 0 | S2 adds z/motion tokens
.viewer-grid-corner | z-index | 1 | S2 adds z/motion tokens
.viewer-grid-letters | z-index | 4 | S2 adds z/motion tokens
.viewer-grid-numbers | z-index | 2 | S2 adds z/motion tokens
.viewer-grid-selection, .viewer-grid-active | z-index | 1 | S2 adds z/motion tokens
.viewer-pdf-text | z-index | 0 | S2 adds z/motion tokens
.viewer-pdf-text .viewer-pdf-eoc | z-index | 0 | S2 adds z/motion tokens
.viewer-pdf-text > :not(.markedContent), .viewer-pdf-text .markedContent span:not(.markedContent) | z-index | 1 | S2 adds z/motion tokens
### extension/src/widget.styles.ts
.vg-card | z-index | 2147483647 | S2 adds z/motion tokens
.vg-model__menu | z-index | 40 | S2 adds z/motion tokens
.vg-more [role="menu"] | z-index | 5 | S2 adds z/motion tokens
.vg-pill | z-index | 2147483647 | S2 adds z/motion tokens

## raw-duration
### app/src/renderer/agent-dock/agent-dock.css
.agent-dock-agent-glyph[data-tone="working"] | animation | agent-dock-pulse 1.6s ease-in-out infinite | S2 adds z/motion tokens
.agent-dock-agent::before | transition | background-color 140ms ease-out | S2 adds z/motion tokens
.agent-dock-agents-n | transition | color 140ms ease-out | S2 adds z/motion tokens
.agent-dock-choice | transition | background-color 140ms ease-out | S2 adds z/motion tokens
.agent-dock-entry, .agent-dock-more, .agent-dock-agents-entry | transition | background-color 140ms ease-out | S2 adds z/motion tokens
.agent-dock-entry-name | transition | color 140ms ease-out | S2 adds z/motion tokens
.agent-dock-group-option | transition | color 140ms ease-out | S2 adds z/motion tokens
.agent-dock-prompt | transition | border-color 140ms ease-out | S2 adds z/motion tokens
.agent-dock-qtab | transition | color 140ms ease-out | S2 adds z/motion tokens
.agent-dock-reveal-link | transition | color 140ms ease-out, text-decoration-color 140ms ease-out | S2 adds z/motion tokens
.agent-dock-title-btn | transition | background-color 140ms ease-out, color 140ms ease-out | S2 adds z/motion tokens
.agent-dock::before | transition | background-color 140ms ease-out | S2 adds z/motion tokens
@media (prefers-reduced-motion: no-preference) .agent-dock-row [data-arrival] | animation | agent-dock-arrival-fill 1.4s ease-out 1 | S2 adds z/motion tokens
@media (prefers-reduced-motion: no-preference) .agent-dock:has(.agent-dock-row [data-arrival="turn"])::before | animation | agent-dock-arrival-edge-accent 1.4s ease-out 1 | S2 adds z/motion tokens
@media (prefers-reduced-motion: no-preference) .agent-dock:has(.agent-dock-row [data-arrival]:not([data-arrival="turn"]))::before | animation | agent-dock-arrival-edge-warn 1.4s ease-out 1 | S2 adds z/motion tokens
### app/src/renderer/background-terminals.css
#bg-toggle | transition | transform 140ms ease-out, background-color 140ms ease-out, color 140ms ease-out | S2 adds z/motion tokens
.bg-group-header-row | transition | background-color 140ms ease-out | S2 adds z/motion tokens
.bg-row | transition | background-color 140ms ease-out | S2 adds z/motion tokens
### app/src/renderer/button.css
.btn | transition | background-color 140ms ease-out, color 140ms ease-out | S2 adds z/motion tokens
### app/src/renderer/document-review/document-review.css
.review-screenshot-remove | transition | opacity 120ms ease-out | S2 adds z/motion tokens
### app/src/renderer/panes.css
#divider | transition | background-color 120ms ease-out | S2 adds z/motion tokens
### app/src/renderer/remote/remote.css
.remote-back::before | transition | background-color 140ms ease-out | S2 adds z/motion tokens
.remote-composer-actions .menu-panel | animation | remote-popover-in 140ms ease-out both | S2 adds z/motion tokens
.remote-information-view | animation | remote-reading-view-in 160ms ease-out both | S2 adds z/motion tokens
.remote-navigation-dismiss | animation | remote-scrim-in 160ms ease-out both | S2 adds z/motion tokens
.remote-navigation-item | transition | background-color 140ms ease-out, color 140ms ease-out | S2 adds z/motion tokens
.remote-navigation-menu | animation | remote-navigation-in 180ms cubic-bezier(0.22, 1, 0.36, 1) both | S2 adds z/motion tokens
.remote-navigation-trigger::before | transition | background-color 140ms ease-out | S2 adds z/motion tokens
.remote-row-menu | animation | remote-popover-in 140ms ease-out both | S2 adds z/motion tokens
.remote-sheet | animation | remote-sheet-in 180ms cubic-bezier(0.22, 1, 0.36, 1) both | S2 adds z/motion tokens
.remote-sheet-dismiss | animation | remote-scrim-in 160ms ease-out both | S2 adds z/motion tokens
.remote-sheet-option | transition | background-color 140ms ease-out, color 140ms ease-out | S2 adds z/motion tokens
.remote-usage | animation | remote-reading-view-in 160ms ease-out both | S2 adds z/motion tokens
@media (min-width: 1200px) .remote-information-rail | animation | remote-rail-in 160ms ease-out both | S2 adds z/motion tokens
### app/src/renderer/sidebar/sidebar.css
.action-row::after | transition | opacity 140ms ease-out | S2 adds z/motion tokens
.attachment-row | transition | background-color 140ms ease-out | S2 adds z/motion tokens
.clamp-cue | transition | color 140ms ease-out | S2 adds z/motion tokens
.dot-pulse | animation | dot-pulse 1.6s ease-in-out infinite | S2 adds z/motion tokens
.field-reset | transition | color 140ms ease-out | S2 adds z/motion tokens
.icon-btn | transition | background-color 140ms ease-out, color 140ms ease-out | S2 adds z/motion tokens
.input | transition | border-color 140ms ease-out | S2 adds z/motion tokens
.item-row | transition | background-color 140ms ease-out | S2 adds z/motion tokens
.menu-panel | animation | menu-in 120ms ease-out | S2 adds z/motion tokens
.nav-pop-out | animation | nav-out 120ms ease-out forwards | S2 adds z/motion tokens
.nav-push-in | animation | nav-in 150ms ease-out | S2 adds z/motion tokens
.nav-under-away | animation | nav-under-away 150ms ease-out | S2 adds z/motion tokens
.nav-under-back | animation | nav-under-back 120ms ease-out | S2 adds z/motion tokens
.new-item-prompt-field::before | transition | background-color 140ms ease-out | S2 adds z/motion tokens
.project-trigger | transition | background-color 140ms ease-out, color 140ms ease-out | S2 adds z/motion tokens
.segment | transition | background-color 140ms ease-out, color 140ms ease-out | S2 adds z/motion tokens
.sheet | animation | sheet-in 150ms ease-out | S2 adds z/motion tokens
.sheet-scrim | animation | scrim-in 150ms ease-out | S2 adds z/motion tokens
.task-metadata summary::after | transition | transform 140ms ease-out | S2 adds z/motion tokens
.toggle | transition | background-color 140ms ease-out, border-color 140ms ease-out | S2 adds z/motion tokens
.toggle-knob | transition | transform 140ms ease-out | S2 adds z/motion tokens
### app/src/renderer/signals/signals.css
.signals-list-btn | transition | color 140ms ease-out | S2 adds z/motion tokens
.signals-tr | transition | background-color 140ms ease-out | S2 adds z/motion tokens
@media (prefers-reduced-motion: no-preference) .signals-resting .signals-braille-dot | animation | signals-calm-wave 4.8s ease-in-out infinite | S2 adds z/motion tokens
### app/src/renderer/terminal-tabs.css
#new-tab | transition | background-color 140ms ease-out, color 140ms ease-out | S2 adds z/motion tokens
.activity-indicator-dot | animation | activity-indicator-clockwise 1s linear infinite | S2 adds z/motion tokens
.activity-indicator-dot:nth-child(2) | animation-delay | -833ms | S2 adds z/motion tokens
.activity-indicator-dot:nth-child(3) | animation-delay | -167ms | S2 adds z/motion tokens
.activity-indicator-dot:nth-child(4) | animation-delay | -667ms | S2 adds z/motion tokens
.activity-indicator-dot:nth-child(5) | animation-delay | -333ms | S2 adds z/motion tokens
.activity-indicator-dot:nth-child(6) | animation-delay | -500ms | S2 adds z/motion tokens
.activity-indicator-label | animation | activity-indicator-label-breathe 1.8s ease-in-out infinite | S2 adds z/motion tokens
.activity-indicator[data-variant="attention"] .activity-indicator-dot | animation | activity-indicator-attention-color 1.8s ease-in-out infinite | S2 adds z/motion tokens
.activity-indicator[data-variant="attention"] .activity-indicator-dot:nth-child(1) | animation-delay | -0.9s | S2 adds z/motion tokens
.activity-indicator[data-variant="attention"] .activity-indicator-dot:nth-child(2), .activity-indicator[data-variant="attention"] .activity-indicator-dot:nth-child(3) | animation-delay | -0.6s | S2 adds z/motion tokens
.activity-indicator[data-variant="attention"] .activity-indicator-dot:nth-child(4), .activity-indicator[data-variant="attention"] .activity-indicator-dot:nth-child(5) | animation-delay | -0.3s | S2 adds z/motion tokens
.activity-indicator[data-variant="waiting"] .activity-indicator-dot | animation | activity-indicator-waiting 0.9s ease-in-out infinite | S2 adds z/motion tokens
.tab | transition | opacity 140ms ease-out, background-color 140ms ease-out, color 140ms ease-out | S2 adds z/motion tokens
.tab-close | transition | opacity 140ms ease-out, background-color 140ms ease-out | S2 adds z/motion tokens
.tab-group-toggle | transition | background-color 140ms ease-out, color 140ms ease-out | S2 adds z/motion tokens
### app/src/renderer/terminal-well.css
.term-scrollbar-thumb | transition | background-color 140ms ease-out, width 140ms ease-out | S2 adds z/motion tokens
@media (prefers-reduced-motion: no-preference) .term-holder[data-reveal]::after | animation | term-reveal-pulse 1.4s ease-out 1 forwards | S2 adds z/motion tokens
### app/src/renderer/terminal-workspace.ts
element.animate() in animateStripReflow | animation-duration | 160ms | §9 ruling 50 tab drag FLIP 160ms on cubic-bezier(0.2, 0.8, 0.2, 1) (§3.18; a sanctioned §2.5 exception, S2 motion tokens pending)
preview.animate() in settleBackgroundTabPreview | animation-duration | 140ms | §9 ruling 50 drag settle 180ms (140ms into Background) on cubic-bezier(0.2, 0.8, 0.2, 1) (§3.18; a sanctioned §2.5 exception, S2 motion tokens pending)
preview.animate() in settleBackgroundTabPreview | animation-duration | 180ms | §9 ruling 50 drag settle 180ms (140ms into Background) on cubic-bezier(0.2, 0.8, 0.2, 1) (§3.18; a sanctioned §2.5 exception, S2 motion tokens pending)
preview.animate() in settleGroupPreview | animation-duration | 140ms | §9 ruling 50 drag settle 180ms (140ms into Background) on cubic-bezier(0.2, 0.8, 0.2, 1) (§3.18; a sanctioned §2.5 exception, S2 motion tokens pending)
preview.animate() in settleGroupPreview | animation-duration | 180ms | §9 ruling 50 drag settle 180ms (140ms into Background) on cubic-bezier(0.2, 0.8, 0.2, 1) (§3.18; a sanctioned §2.5 exception, S2 motion tokens pending)
preview.animate() in settleTabPreview | animation-duration | 140ms | §9 ruling 50 drag settle 180ms (140ms into Background) on cubic-bezier(0.2, 0.8, 0.2, 1) (§3.18; a sanctioned §2.5 exception, S2 motion tokens pending)
preview.animate() in settleTabPreview | animation-duration | 180ms | §9 ruling 50 drag settle 180ms (140ms into Background) on cubic-bezier(0.2, 0.8, 0.2, 1) (§3.18; a sanctioned §2.5 exception, S2 motion tokens pending)
### app/src/renderer/toast.css
.toast | transition | opacity 150ms ease-out, transform 150ms ease-out | S2 adds z/motion tokens
.toast.leaving | transition-duration | 120ms | S2 adds z/motion tokens
### app/src/renderer/viewer/viewer.css
.viewer-grid-letter, .viewer-grid-number | transition | color var(--motion-state, 140ms) ease-out | S2 adds z/motion tokens: --motion-state is not defined yet, so the 140ms fallback renders
.viewer-pdf-canvas | transition | opacity 150ms ease-out | S2 adds z/motion tokens
### extension/src/widget.styles.ts
.vg-agent__option | transition | background-color 140ms ease-out, color 140ms ease-out | S2 adds z/motion tokens
.vg-btn | transition | background-color 140ms ease-out, color 140ms ease-out | S2 adds z/motion tokens
.vg-card | animation | vg-rise 150ms ease-out | S2 adds z/motion tokens
.vg-close | transition | background-color 140ms ease-out, color 140ms ease-out | S2 adds z/motion tokens
.vg-dot--pulse | animation | vg-pulse 1.6s ease-in-out infinite | S2 adds z/motion tokens
.vg-model__chevron | transition | transform 120ms ease-out | S2 adds z/motion tokens
.vg-model__menu--down | animation | vg-menu-down 120ms ease-out | S2 adds z/motion tokens
.vg-model__menu--up | animation | vg-menu-up 120ms ease-out | S2 adds z/motion tokens
.vg-model__trigger | transition | border-color 140ms ease-out | S2 adds z/motion tokens
.vg-pill | transition | background-color 140ms ease-out, border-color 140ms ease-out, transform 140ms ease-out | S2 adds z/motion tokens
.vg-pr | transition | background-color 140ms ease-out | S2 adds z/motion tokens

## raw-easing
### app/src/renderer/agent-dock/agent-dock.css
.agent-dock-agent-glyph[data-tone="working"] | animation | agent-dock-pulse 1.6s ease-in-out infinite | S2 adds z/motion tokens
.agent-dock-agent::before | transition | background-color 140ms ease-out | S2 adds z/motion tokens
.agent-dock-agents-n | transition | color 140ms ease-out | S2 adds z/motion tokens
.agent-dock-choice | transition | background-color 140ms ease-out | S2 adds z/motion tokens
.agent-dock-entry, .agent-dock-more, .agent-dock-agents-entry | transition | background-color 140ms ease-out | S2 adds z/motion tokens
.agent-dock-entry-name | transition | color 140ms ease-out | S2 adds z/motion tokens
.agent-dock-group-option | transition | color 140ms ease-out | S2 adds z/motion tokens
.agent-dock-prompt | transition | border-color 140ms ease-out | S2 adds z/motion tokens
.agent-dock-qtab | transition | color 140ms ease-out | S2 adds z/motion tokens
.agent-dock-reveal-link | transition | color 140ms ease-out, text-decoration-color 140ms ease-out | S2 adds z/motion tokens
.agent-dock-title-btn | transition | background-color 140ms ease-out, color 140ms ease-out | S2 adds z/motion tokens
.agent-dock::before | transition | background-color 140ms ease-out | S2 adds z/motion tokens
@media (prefers-reduced-motion: no-preference) .agent-dock-row [data-arrival] | animation | agent-dock-arrival-fill 1.4s ease-out 1 | S2 adds z/motion tokens
@media (prefers-reduced-motion: no-preference) .agent-dock:has(.agent-dock-row [data-arrival="turn"])::before | animation | agent-dock-arrival-edge-accent 1.4s ease-out 1 | S2 adds z/motion tokens
@media (prefers-reduced-motion: no-preference) .agent-dock:has(.agent-dock-row [data-arrival]:not([data-arrival="turn"]))::before | animation | agent-dock-arrival-edge-warn 1.4s ease-out 1 | S2 adds z/motion tokens
### app/src/renderer/background-terminals.css
#bg-toggle | transition | transform 140ms ease-out, background-color 140ms ease-out, color 140ms ease-out | S2 adds z/motion tokens
.bg-group-header-row | transition | background-color 140ms ease-out | S2 adds z/motion tokens
.bg-row | transition | background-color 140ms ease-out | S2 adds z/motion tokens
### app/src/renderer/button.css
.btn | transition | background-color 140ms ease-out, color 140ms ease-out | S2 adds z/motion tokens
### app/src/renderer/document-review/document-review.css
.review-screenshot-remove | transition | opacity 120ms ease-out | S2 adds z/motion tokens
### app/src/renderer/panes.css
#divider | transition | background-color 120ms ease-out | S2 adds z/motion tokens
### app/src/renderer/remote/remote.css
.remote-back::before | transition | background-color 140ms ease-out | S2 adds z/motion tokens
.remote-composer-actions .menu-panel | animation | remote-popover-in 140ms ease-out both | S2 adds z/motion tokens
.remote-information-view | animation | remote-reading-view-in 160ms ease-out both | S2 adds z/motion tokens
.remote-navigation-dismiss | animation | remote-scrim-in 160ms ease-out both | S2 adds z/motion tokens
.remote-navigation-item | transition | background-color 140ms ease-out, color 140ms ease-out | S2 adds z/motion tokens
.remote-navigation-menu | animation | remote-navigation-in 180ms cubic-bezier(0.22, 1, 0.36, 1) both | S2 adds z/motion tokens
.remote-navigation-trigger::before | transition | background-color 140ms ease-out | S2 adds z/motion tokens
.remote-row-menu | animation | remote-popover-in 140ms ease-out both | S2 adds z/motion tokens
.remote-sheet | animation | remote-sheet-in 180ms cubic-bezier(0.22, 1, 0.36, 1) both | S2 adds z/motion tokens
.remote-sheet-dismiss | animation | remote-scrim-in 160ms ease-out both | S2 adds z/motion tokens
.remote-sheet-option | transition | background-color 140ms ease-out, color 140ms ease-out | S2 adds z/motion tokens
.remote-usage | animation | remote-reading-view-in 160ms ease-out both | S2 adds z/motion tokens
@media (min-width: 1200px) .remote-information-rail | animation | remote-rail-in 160ms ease-out both | S2 adds z/motion tokens
### app/src/renderer/sidebar/sidebar.css
.action-row::after | transition | opacity 140ms ease-out | S2 adds z/motion tokens
.attachment-row | transition | background-color 140ms ease-out | S2 adds z/motion tokens
.clamp-cue | transition | color 140ms ease-out | S2 adds z/motion tokens
.dot-pulse | animation | dot-pulse 1.6s ease-in-out infinite | S2 adds z/motion tokens
.field-reset | transition | color 140ms ease-out | S2 adds z/motion tokens
.icon-btn | transition | background-color 140ms ease-out, color 140ms ease-out | S2 adds z/motion tokens
.input | transition | border-color 140ms ease-out | S2 adds z/motion tokens
.item-row | transition | background-color 140ms ease-out | S2 adds z/motion tokens
.menu-panel | animation | menu-in 120ms ease-out | S2 adds z/motion tokens
.nav-pop-out | animation | nav-out 120ms ease-out forwards | S2 adds z/motion tokens
.nav-push-in | animation | nav-in 150ms ease-out | S2 adds z/motion tokens
.nav-under-away | animation | nav-under-away 150ms ease-out | S2 adds z/motion tokens
.nav-under-back | animation | nav-under-back 120ms ease-out | S2 adds z/motion tokens
.new-item-prompt-field::before | transition | background-color 140ms ease-out | S2 adds z/motion tokens
.project-trigger | transition | background-color 140ms ease-out, color 140ms ease-out | S2 adds z/motion tokens
.segment | transition | background-color 140ms ease-out, color 140ms ease-out | S2 adds z/motion tokens
.sheet | animation | sheet-in 150ms ease-out | S2 adds z/motion tokens
.sheet-scrim | animation | scrim-in 150ms ease-out | S2 adds z/motion tokens
.task-metadata summary::after | transition | transform 140ms ease-out | S2 adds z/motion tokens
.toggle | transition | background-color 140ms ease-out, border-color 140ms ease-out | S2 adds z/motion tokens
.toggle-knob | transition | transform 140ms ease-out | S2 adds z/motion tokens
### app/src/renderer/sidebar/swipe.ts
in SWIPE_COMMIT_EASING | string | cubic-bezier(0.16, 1, 0.3, 1) | §9 ruling 35 swipe-back settle curve (§3.10; a sanctioned §2.5 exception, S2 motion tokens pending)
in SWIPE_SPRING_EASING | string | cubic-bezier(0.32, 0.72, 0, 1) | §9 ruling 35 swipe-back settle curve (§3.10; a sanctioned §2.5 exception, S2 motion tokens pending)
### app/src/renderer/signals/signals.css
.signals-list-btn | transition | color 140ms ease-out | S2 adds z/motion tokens
.signals-tr | transition | background-color 140ms ease-out | S2 adds z/motion tokens
@media (prefers-reduced-motion: no-preference) .signals-resting .signals-braille-dot | animation | signals-calm-wave 4.8s ease-in-out infinite | S2 adds z/motion tokens
### app/src/renderer/terminal-tabs.css
#new-tab | transition | background-color 140ms ease-out, color 140ms ease-out | S2 adds z/motion tokens
.activity-indicator-dot | animation | activity-indicator-clockwise 1s linear infinite | S2 adds z/motion tokens
.activity-indicator-label | animation | activity-indicator-label-breathe 1.8s ease-in-out infinite | S2 adds z/motion tokens
.activity-indicator[data-variant="attention"] .activity-indicator-dot | animation | activity-indicator-attention-color 1.8s ease-in-out infinite | S2 adds z/motion tokens
.activity-indicator[data-variant="waiting"] .activity-indicator-dot | animation | activity-indicator-waiting 0.9s ease-in-out infinite | S2 adds z/motion tokens
.tab | transition | opacity 140ms ease-out, background-color 140ms ease-out, color 140ms ease-out | S2 adds z/motion tokens
.tab-close | transition | opacity 140ms ease-out, background-color 140ms ease-out | S2 adds z/motion tokens
.tab-group-toggle | transition | background-color 140ms ease-out, color 140ms ease-out | S2 adds z/motion tokens
### app/src/renderer/terminal-well.css
.term-scrollbar-thumb | transition | background-color 140ms ease-out, width 140ms ease-out | S2 adds z/motion tokens
@media (prefers-reduced-motion: no-preference) .term-holder[data-reveal]::after | animation | term-reveal-pulse 1.4s ease-out 1 forwards | S2 adds z/motion tokens
### app/src/renderer/terminal-workspace.ts
element.animate() in animateStripReflow | animation-timing-function | cubic-bezier(0.2, 0.8, 0.2, 1) | §9 ruling 50 tab drag FLIP 160ms on cubic-bezier(0.2, 0.8, 0.2, 1) (§3.18; a sanctioned §2.5 exception, S2 motion tokens pending)
preview.animate() in settleBackgroundTabPreview | animation-timing-function | cubic-bezier(0.2, 0.8, 0.2, 1) | §9 ruling 50 drag settle 180ms (140ms into Background) on cubic-bezier(0.2, 0.8, 0.2, 1) (§3.18; a sanctioned §2.5 exception, S2 motion tokens pending)
preview.animate() in settleGroupPreview | animation-timing-function | cubic-bezier(0.2, 0.8, 0.2, 1) | §9 ruling 50 drag settle 180ms (140ms into Background) on cubic-bezier(0.2, 0.8, 0.2, 1) (§3.18; a sanctioned §2.5 exception, S2 motion tokens pending)
preview.animate() in settleTabPreview | animation-timing-function | cubic-bezier(0.2, 0.8, 0.2, 1) | §9 ruling 50 drag settle 180ms (140ms into Background) on cubic-bezier(0.2, 0.8, 0.2, 1) (§3.18; a sanctioned §2.5 exception, S2 motion tokens pending)
### app/src/renderer/toast.css
.toast | transition | opacity 150ms ease-out, transform 150ms ease-out | S2 adds z/motion tokens
### app/src/renderer/toast.ts
countdownEl.style in showToast | transition | transform var(--expr)ms linear | S2 adds z/motion tokens
### app/src/renderer/viewer/viewer.css
.viewer-grid-letter, .viewer-grid-number | transition | color var(--motion-state, 140ms) ease-out | S2 adds z/motion tokens
.viewer-pdf-canvas | transition | opacity 150ms ease-out | S2 adds z/motion tokens
### extension/src/widget.styles.ts
.vg-agent__option | transition | background-color 140ms ease-out, color 140ms ease-out | S2 adds z/motion tokens
.vg-btn | transition | background-color 140ms ease-out, color 140ms ease-out | S2 adds z/motion tokens
.vg-card | animation | vg-rise 150ms ease-out | S2 adds z/motion tokens
.vg-close | transition | background-color 140ms ease-out, color 140ms ease-out | S2 adds z/motion tokens
.vg-dot--pulse | animation | vg-pulse 1.6s ease-in-out infinite | S2 adds z/motion tokens
.vg-model__chevron | transition | transform 120ms ease-out | S2 adds z/motion tokens
.vg-model__menu--down | animation | vg-menu-down 120ms ease-out | S2 adds z/motion tokens
.vg-model__menu--up | animation | vg-menu-up 120ms ease-out | S2 adds z/motion tokens
.vg-model__trigger | transition | border-color 140ms ease-out | S2 adds z/motion tokens
.vg-pill | transition | background-color 140ms ease-out, border-color 140ms ease-out, transform 140ms ease-out | S2 adds z/motion tokens
.vg-pr | transition | background-color 140ms ease-out | S2 adds z/motion tokens

## radius-off-scale
### app/src/renderer/agent-dock/agent-dock.css
.agent-dock-agents-seg | border-radius | 1.5px | D17 off-scale values the scale picks did not settle (radii under 4px)
.agent-dock-choices[data-multi="true"] .agent-dock-choice-cursor | border-radius | 3px | D17 off-scale values the scale picks did not settle (radii under 4px)
### app/src/renderer/sidebar/sidebar.css
.color-input::-webkit-color-swatch | border-radius | 3px | D17 off-scale values the scale picks did not settle (radii under 4px)
.new-item-prompt-field::before | border-radius | 1px | D17 off-scale values the scale picks did not settle (radii under 4px)
.segmented-index .segment-active .segment-body::after | border-radius | 1px | D17 off-scale values the scale picks did not settle (radii under 4px)
### app/src/renderer/viewer/viewer.css
.viewer-code .cm-editor .cm-searchMatch | border-radius | 2px | D17 off-scale values the scale picks did not settle (radii under 4px)
.viewer-pdf-paper | border-radius | 2px | D17 off-scale values the scale picks did not settle (radii under 4px)

## spacing-off-scale
### app/assets/remote/remote-sw.js
body | padding | 48px 24px | D16 Remote offline page type and spacing (served by remote-sw.js; cannot load tokens.css)
### app/src/renderer/agent-dock/agent-dock.css
.agent-dock-agents-bar | gap | 2px | D17 off-scale values the scale picks did not settle (2px steps and component dimensions)
.agent-dock-md :is(ul, ol) | padding-left | 18px | D17 off-scale values the scale picks did not settle (2px steps and component dimensions)
.agent-dock-md blockquote | padding-left | 18px | D17 off-scale values the scale picks did not settle (2px steps and component dimensions)
.agent-dock-md li | padding-left | 2px | D17 off-scale values the scale picks did not settle (2px steps and component dimensions)
.agent-dock-md li + li, .agent-dock-md li > :is(ul, ol), .agent-dock-md li > p + * | margin-top | 2px | D17 off-scale values the scale picks did not settle (2px steps and component dimensions)
.agent-dock-md p + :is(ul, ol) | margin-top | 2px | D17 off-scale values the scale picks did not settle (2px steps and component dimensions)
.agent-dock-source + .agent-dock-source::before | margin-right | 2px | D17 off-scale values the scale picks did not settle (2px steps and component dimensions)
### app/src/renderer/background-terminals.css
.bg-count | padding | 2px 8px | D17 off-scale values the scale picks did not settle (2px steps and component dimensions)
### app/src/renderer/button.css
.btn | padding | 0 14px | D17 off-scale values the scale picks did not settle (2px steps and component dimensions)
### app/src/renderer/document-review/document-review.css
.review-header | padding | 8px 16px 8px 90px | D17 off-scale values the scale picks did not settle (2px steps and component dimensions)
.review-reading | padding | 20px 40px 80px 32px | D17 off-scale values the scale picks did not settle (2px steps and component dimensions)
.review-screenshots | padding | 2px | D17 off-scale values the scale picks did not settle (2px steps and component dimensions)
@media (max-width: 900px) .review-header | padding-left | 90px | D17 off-scale values the scale picks did not settle (2px steps and component dimensions)
@media (max-width: 900px) .review-reading | padding-inline | 24px 40px | D17 off-scale values the scale picks did not settle (2px steps and component dimensions)
### app/src/renderer/remote/remote.css
.remote-chat > .remote-header | margin-bottom | calc(-44px - env(safe-area-inset-top, 0px)) | D17 off-scale values the scale picks did not settle (2px steps and component dimensions)
.remote-chat > .remote-header + .remote-reading-stage > .remote-reading-area > .remote-transcript | padding-top | calc(68px + env(safe-area-inset-top, 0px)) | D17 off-scale values the scale picks did not settle (2px steps and component dimensions)
.remote-chat > .remote-header + :is(.remote-notice, .remote-history) | margin-top | calc(44px + env(safe-area-inset-top, 0px)) | D17 off-scale values the scale picks did not settle (2px steps and component dimensions)
.remote-information h3 | padding-left | 2px | D17 off-scale values the scale picks did not settle (2px steps and component dimensions)
.remote-markdown code | padding | 2px 4px | D17 off-scale values the scale picks did not settle (2px steps and component dimensions)
.remote-message[data-role="user"] .remote-user-text | padding | 8px 14px | D17 off-scale values the scale picks did not settle (2px steps and component dimensions)
.remote-sheet | padding | 18px 0 max(12px, env(safe-area-inset-bottom, 0px)) | D17 off-scale values the scale picks did not settle (2px steps and component dimensions)
.remote-transcript | padding | 24px 16px calc(28px + var(--remote-composer-overlap, 76px)) | D17 off-scale values the scale picks did not settle (2px steps and component dimensions)
.remote-workspace .remote-compose-open textarea | padding | 8px 12px 2px | D17 off-scale values the scale picks did not settle (2px steps and component dimensions)
### app/src/renderer/run-context/run-context-editor.css
.run-context-banner > div | gap | 2px | D17 off-scale values the scale picks did not settle (2px steps and component dimensions)
.run-context-dialog | padding | 22px 24px | D17 off-scale values the scale picks did not settle (2px steps and component dimensions)
.run-context-dialog p, .run-context-start-state p | margin | 8px 0 22px | D17 off-scale values the scale picks did not settle (2px steps and component dimensions)
.run-context-editor | padding | 28px max(36px, calc((100% - 760px) / 2)) | D17 off-scale values the scale picks did not settle (2px steps and component dimensions)
.run-context-header | padding | 0 16px 0 84px | D17 off-scale values the scale picks did not settle (2px steps and component dimensions)
.run-context-kicker | margin-bottom | 2px | D17 off-scale values the scale picks did not settle (2px steps and component dimensions)
.run-context-source dl > div | gap | 2px | D17 off-scale values the scale picks did not settle (2px steps and component dimensions)
### app/src/renderer/sidebar/sidebar.css
.chip | padding | 2px 8px | §9 ruling 26 chip padding 2×8
.color-input::-webkit-color-swatch-wrapper | padding | 3px | D17 off-scale values the scale picks did not settle (the 3px padding is tied to the swatch's 3px inner radius, §3.7)
.item-row-actions | gap | 2px | D17 off-scale values the scale picks did not settle (2px steps and component dimensions)
.item-row-shell-actions .item-row | padding-right | 84px | D17 off-scale values the scale picks did not settle (2px steps and component dimensions)
.menu-trigger-badge | padding | 2px 8px | §9 ruling 26 chip padding 2×8
.remote-device-state | margin-top | 2px | D17 off-scale values the scale picks did not settle (2px steps and component dimensions)
.select | padding-right | 28px | D17 off-scale values the scale picks did not settle (2px steps and component dimensions)
.sheet-heading | padding-top | 2px | D17 off-scale values the scale picks did not settle (2px steps and component dimensions)
.shortcut-scope | margin | 14px 0 0 | D17 off-scale values the scale picks did not settle (2px steps and component dimensions)
.shortcut-title | gap | 2px | D17 off-scale values the scale picks did not settle (2px steps and component dimensions)
### app/src/renderer/signals/signals.css
.signals-braille | margin-bottom | 14px | D17 off-scale values the scale picks did not settle (2px steps and component dimensions)
.signals-braille-mark .signals-braille-cell | gap | 2px | D17 off-scale values the scale picks did not settle (2px steps and component dimensions)
.signals-foot-hints | gap | 2px 14px | D17 off-scale values the scale picks did not settle (2px steps and component dimensions)
.signals-section + .signals-section | margin-top | 28px | D17 off-scale values the scale picks did not settle (2px steps and component dimensions)
.signals-section .signals-tr | scroll-margin-top | 28px | D17 off-scale values the scale picks did not settle (2px steps and component dimensions)
### app/src/renderer/terminal-tabs.css
.activity-indicator | gap | 2px | D17 off-scale values the scale picks did not settle (2px steps and component dimensions)
.tab-running | margin-right | 2px | D17 off-scale values the scale picks did not settle (2px steps and component dimensions)
### app/src/renderer/terminal-well.css
.term-holder | padding | 14px 0 14px 16px | D17 off-scale values the scale picks did not settle (2px steps and component dimensions)
### app/src/renderer/topbar.css
.topbar-left | padding-left | 84px | D17 off-scale values the scale picks did not settle (2px steps and component dimensions)
### app/src/renderer/viewer/viewer.css
.viewer-code .cm-editor .cm-panel.cm-search | padding | 8px 48px 8px 16px | D17 off-scale values the scale picks did not settle (2px steps and component dimensions)
.viewer-pdf-password | margin | 48px auto | D17 off-scale values the scale picks did not settle (2px steps and component dimensions)
### extension/src/widget.styles.ts
.vg-btn | padding | 0 14px | §9 ruling 88 widget buttons are the §3.1 md button (0 14 as .btn; the 14 itself is D17, a component dimension the scale picks did not settle)
.vg-chip | padding | 2px 8px | §9 ruling 26 chip padding 2×8
.vg-pr | padding | 0 14px | §9 ruling 88 widget buttons are the §3.1 md button (0 14 as .btn; the 14 itself is D17, a component dimension the scale picks did not settle)

## font-size-off-scale
### app/assets/remote/remote-sw.js
body | font | 16px/1.6 -apple-system,BlinkMacSystemFont,sans-serif | D16 Remote offline page type and spacing (served by remote-sw.js; cannot load tokens.css)
h1 | font-size | 24px | D16 Remote offline page type and spacing (served by remote-sw.js; cannot load tokens.css)
### app/src/renderer/agent-dock/agent-dock.css
.agent-dock-message-mark | font-size | calc(9px * var(--ui-scale)) | D17 off-scale values the scale picks did not settle (type outside Remote and the count badges)
### app/src/renderer/background-terminals.css
.bg-action-glyph | font-size | 16px | D17 off-scale values the scale picks did not settle (type outside Remote and the count badges)
.bg-kill-glyph | font-size | 14px | D17 off-scale values the scale picks did not settle (type outside Remote and the count badges)
### app/src/renderer/reading-width.css
[data-reading-width] :not(pre) > code | font-size | 0.92em | D17 off-scale values the scale picks did not settle (type outside Remote and the count badges)
### app/src/renderer/remote/remote.css
.remote-markdown code | font-size | 0.92em | D17 off-scale values the scale picks did not settle (type outside Remote and the count badges)
### app/src/renderer/run-context/run-context-editor.css
.run-context-dialog h2, .run-context-start-state h1 | font-size | calc(15px * var(--ui-scale)) | D17 off-scale values the scale picks did not settle (type outside Remote and the count badges)
.run-context-editor .bn-editor | font-size | calc(14px * var(--ui-scale)) | D17 off-scale values the scale picks did not settle (type outside Remote and the count badges)
.run-context-heading h1 | font-size | calc(14px * var(--ui-scale)) | D17 off-scale values the scale picks did not settle (type outside Remote and the count badges)
.run-context-kicker | font-size | calc(10px * var(--ui-scale)) | D17 off-scale values the scale picks did not settle (type outside Remote and the count badges)
.run-context-source dt | font-size | calc(10px * var(--ui-scale)) | D17 off-scale values the scale picks did not settle (type outside Remote and the count badges)
### app/src/renderer/sidebar/sidebar.css
.item-project-group-head > span:last-child | font-size | calc(10px * var(--ui-scale)) | D17 off-scale values the scale picks did not settle (type outside Remote and the count badges)
.menu-item-color | font-size | calc(14px * var(--ui-scale)) | D17 off-scale values the scale picks did not settle (type outside Remote and the count badges)
### app/src/renderer/terminal-tabs.css
#new-tab | font-size | 16px | D17 off-scale values the scale picks did not settle (type outside Remote and the count badges)
### app/src/renderer/viewer/viewer.css
.viewer-grid-letter, .viewer-grid-number | font-size | 0.92em | D17 off-scale values the scale picks did not settle (type outside Remote and the count badges)
.viewer-pdf-password-title | font-size | calc(14px * var(--ui-scale)) | D17 off-scale values the scale picks did not settle (type outside Remote and the count badges)
### extension/src/widget.styles.ts
.vg-close | font-size | 16px | D17 off-scale values the scale picks did not settle (type outside Remote and the count badges)
.vg-error__dismiss | font-size | 16px | D17 off-scale values the scale picks did not settle (type outside Remote and the count badges)

## inline-svg
### app/src/renderer/index.html
html | markup | <svg viewBox="0 0 24 24"> | §9 ruling 54: static first-paint copy of the icon module's backgroundStack, held equal by tests/design-icons.test.ts
### app/src/renderer/sidebar/sidebar.css
.select | background-image | url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' … #3f163f2b | §9 ruling 95: the outline Chevron Down as a CSS data URI (listed in ICONS_OUTSIDE_MODULE, held to the set by tests/design-icons.test.ts)
### extension/src/Widget.tsx
in ModelSelect | jsx | <svg viewBox="0 0 24 24"> | §9 ruling 95: outline Chevron Down in the SolidJS extension (§9 ruling 104: it keeps its own icons, held to the set by tests/design-icons.test.ts)
in ModelSelect | jsx | <svg viewBox="0 0 24 24"> | §9 ruling 95: outline Check in the SolidJS extension (§9 ruling 104: it keeps its own icons, held to the set by tests/design-icons.test.ts)

## primitive-outside-owner
### extension/src/widget.styles.ts
.chip-amber | chip | .chip-amber | §9 ruling 104: the SolidJS extension widget keeps its own chip tones (not the app chip primitive)
.chip-blue | chip | .chip-blue | §9 ruling 104: the SolidJS extension widget keeps its own chip tones (not the app chip primitive)
.chip-gray | chip | .chip-gray | §9 ruling 104: the SolidJS extension widget keeps its own chip tones (not the app chip primitive)
.chip-green | chip | .chip-green | §9 ruling 104: the SolidJS extension widget keeps its own chip tones (not the app chip primitive)
.chip-red | chip | .chip-red | §9 ruling 104: the SolidJS extension widget keeps its own chip tones (not the app chip primitive)

## button-border
### app/src/renderer/sidebar/sidebar.css
.shortcut-alias button + button | border-left | 1px solid var(--hairline) | D18 Shortcut alias divider: the Terminal settings shortcut chips draw a border between alias buttons, against §9 ruling 4 (a separator element, an exception or no divider)
`

export const DESIGN_LINT_ALLOWLIST: readonly AllowlistEntry[] = parseBaseline(DESIGN_LINT_BASELINE)
