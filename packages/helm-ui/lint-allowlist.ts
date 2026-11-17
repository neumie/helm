// Design lint baseline: every finding of packages/helm-ui/lint.ts that is allowed to stay, with the decision
// (docs/plans/design-system/spec.md D<n>), ruling (docs/design-system.md §9 ruling N) or plan stage (S<n>) that
// keeps it. tests/design-lint.test.ts fails on a finding missing here, on an entry with no finding left (the
// value was fixed: remove it), on a `TODO:` reason and on a rule count above its cap. Regenerate with
// `node --import tsx packages/helm-ui/scripts/design-lint.ts --write-baseline`, which keeps the reasons below for entries
// that still match and refuses new entries unless `--allow-new` is given; edit reasons by hand. Never add an
// entry to let new code through: use a token, or get a ruling first.
//
// Format, under `## <rule>` and `### <file>` headers: <selector> | <property> | <value> | <reason>
import { type AllowlistEntry, parseBaseline } from './lint.ts'

export const DESIGN_LINT_BASELINE = String.raw`
## token-definition
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

## raw-z-index
### app/src/renderer/remote/remote.css
.remote-navigation-scrim | z-index | 70 | D19 no z-index or motion token holds this value (S2 put the others on tokens)
### app/src/renderer/sidebar/sidebar.css
.swipe-scrim | z-index | 30 | D19 no z-index or motion token holds this value (S2 put the others on tokens)
### app/src/renderer/terminal-well.css
.term-holder[data-reveal]::after | z-index | 9 | D19 no z-index or motion token holds this value (S2 put the others on tokens)
.term-mount .term-frame-freeze | z-index | 8 | D19 no z-index or motion token holds this value (S2 put the others on tokens)
### extension/src/widget.styles.ts
.vg-more [role="menu"] | z-index | 5 | D19 no z-index or motion token holds this value (S2 put the others on tokens)

## raw-duration
### app/src/renderer/remote/remote.css
.remote-information-view | animation | remote-reading-view-in 160ms ease-out both | D19 no z-index or motion token holds this value (S2 put the others on tokens)
.remote-navigation-dismiss | animation | remote-scrim-in 160ms ease-out both | D19 no z-index or motion token holds this value (S2 put the others on tokens)
.remote-navigation-menu | animation | remote-navigation-in 180ms cubic-bezier(0.22, 1, 0.36, 1) both | D19 no z-index or motion token holds this value (S2 put the others on tokens)
.remote-sheet | animation | remote-sheet-in 180ms cubic-bezier(0.22, 1, 0.36, 1) both | D19 no z-index or motion token holds this value (S2 put the others on tokens)
.remote-sheet-dismiss | animation | remote-scrim-in 160ms ease-out both | D19 no z-index or motion token holds this value (S2 put the others on tokens)
.remote-usage | animation | remote-reading-view-in 160ms ease-out both | D19 no z-index or motion token holds this value (S2 put the others on tokens)
@media (min-width: 1200px) .remote-information-rail | animation | remote-rail-in 160ms ease-out both | D19 no z-index or motion token holds this value (S2 put the others on tokens)

## raw-easing
### app/src/renderer/remote/remote.css
.remote-information-view | animation | remote-reading-view-in 160ms ease-out both | D19 no z-index or motion token holds this value (S2 put the others on tokens)
.remote-navigation-dismiss | animation | remote-scrim-in 160ms ease-out both | D19 no z-index or motion token holds this value (S2 put the others on tokens)
.remote-navigation-menu | animation | remote-navigation-in 180ms cubic-bezier(0.22, 1, 0.36, 1) both | D19 no z-index or motion token holds this value (S2 put the others on tokens)
.remote-sheet | animation | remote-sheet-in 180ms cubic-bezier(0.22, 1, 0.36, 1) both | D19 no z-index or motion token holds this value (S2 put the others on tokens)
.remote-sheet-dismiss | animation | remote-scrim-in 160ms ease-out both | D19 no z-index or motion token holds this value (S2 put the others on tokens)
.remote-usage | animation | remote-reading-view-in 160ms ease-out both | D19 no z-index or motion token holds this value (S2 put the others on tokens)
@media (min-width: 1200px) .remote-information-rail | animation | remote-rail-in 160ms ease-out both | D19 no z-index or motion token holds this value (S2 put the others on tokens)

## spacing-off-scale
### app/src/renderer/agent-dock/agent-dock.css
.agent-dock-md :is(ul, ol) | padding-left | 18px | §9 ruling 120 component metric (§3.24 Metrics: Markdown list indent 18)
.agent-dock-md blockquote | padding-left | 18px | §9 ruling 120 component metric (§3.24 Metrics: Markdown quote indent 18)
### app/src/renderer/button.css
.btn | padding | 0 14px | §9 ruling 120 component metric (§3.1 Metrics: md button padding 0 14)
### app/src/renderer/document-review/document-review.css
.review-header | padding | 8px 16px 8px 90px | §9 ruling 120 component metric (§3.26 Metrics: 90px traffic-light reserve)
.review-reading | padding | 20px 40px 80px 32px | §9 ruling 120 component metric (§3.26 Metrics: reading padding 20 40 80 32)
@media (max-width: 900px) .review-header | padding-left | 90px | §9 ruling 120 component metric (§3.26 Metrics: 90px traffic-light reserve)
@media (max-width: 900px) .review-reading | padding-inline | 24px 40px | §9 ruling 120 component metric (§3.26 Metrics: narrow reading padding 24 40)
### app/src/renderer/remote/remote.css
.remote-chat > .remote-header | margin-bottom | calc(-44px - env(safe-area-inset-top, 0px)) | §9 ruling 120 component metric (§3.23 Metrics: 44px header overlap)
.remote-chat > .remote-header + .remote-reading-stage > .remote-reading-area > .remote-transcript | padding-top | calc(68px + env(safe-area-inset-top, 0px)) | §9 ruling 120 component metric (§3.23 Metrics: transcript starts 68 below the header, 44 + 24)
.remote-chat > .remote-header + :is(.remote-notice, .remote-history) | margin-top | calc(44px + env(safe-area-inset-top, 0px)) | §9 ruling 120 component metric (§3.23 Metrics: notices and History 44 below the header)
.remote-message[data-role="user"] .remote-user-text | padding | 8px 14px | §9 ruling 120 component metric (§3.23 Metrics: user bubble padding 8 14)
.remote-transcript | padding | 24px 16px calc(28px + var(--remote-composer-overlap, 76px)) | §9 ruling 120 component metric (§3.23 Metrics: 28 end reserve above the composer)
### app/src/renderer/run-context/run-context-editor.css
.run-context-editor | padding | 32px max(36px, calc((100% - 760px) / 2)) | §9 ruling 120 component metric (§3.22 Metrics: side margin at least 36 around the 760 measure)
.run-context-header | padding | 0 16px 0 84px | §9 ruling 120 component metric (§3.22 Metrics: 84px traffic-light reserve)
### app/src/renderer/sidebar/sidebar.css
.item-row-shell-actions .item-row | padding-right | 84px | §9 ruling 120 component metric (§3.3: 84 room for the queue row's two icon buttons)
.select | padding-right | 28px | §9 ruling 120 component metric (§3.7: 28 chevron room)
### app/src/renderer/terminal-well.css
.term-holder | padding | 14px 0 14px 16px | §9 ruling 120 component metric (§3.14: well inset 14, flexed 6-14 by fitTab)
### app/src/renderer/topbar.css
.topbar-left | padding-left | 84px | §9 ruling 120 component metric (§3.14: 84px traffic-light reserve)
### app/src/renderer/viewer/viewer.css
.viewer-code .cm-editor .cm-panel.cm-search | padding | 8px 48px 8px 16px | §9 ruling 120 component metric (§3.27 Metrics: search panel keeps 48 for its close control)
.viewer-pdf-password | margin | 48px auto | §9 ruling 120 component metric (§3.27 Metrics: password form 48 below the top of the well)
### extension/src/widget.styles.ts
.vg-btn | padding | 0 14px | §9 ruling 88 widget buttons are the §3.1 md button; the 0 14 is a §9 ruling 120 component metric (§3.1 Metrics, §3.28)
.vg-pr | padding | 0 14px | §9 ruling 88 widget buttons are the §3.1 md button; the 0 14 is a §9 ruling 120 component metric (§3.1 Metrics, §3.28)

## font-size-off-scale
### app/src/renderer/agent-dock/agent-dock.css
.agent-dock-message-mark | font-size | calc(9px * var(--ui-scale)) | §9 ruling 121 glyph sized as its icon slot (§3.24 Metrics: message mark 9)
### app/src/renderer/background-terminals.css
.bg-action-glyph | font-size | 16px | §9 ruling 121 glyph sized as its icon slot (§3.18 Glyph sizes: ⇥ 16)
.bg-kill-glyph | font-size | 14px | §9 ruling 121 glyph sized as its icon slot (§3.18 Glyph sizes: × 14)
### app/src/renderer/sidebar/sidebar.css
.menu-item-color | font-size | calc(14px * var(--ui-scale)) | §9 ruling 121 glyph sized as its icon slot (§3.18 Glyph sizes: Color… menu ● 14)
### app/src/renderer/terminal-tabs.css
#new-tab | font-size | 16px | §9 ruling 121 glyph sized as its icon slot (§3.18 Glyph sizes: + New terminal 16)
### extension/src/widget.styles.ts
.vg-close | font-size | 16px | §9 ruling 121 glyph sized as its icon slot (§3.28 Widget metrics: close × 16)
.vg-error__dismiss | font-size | 16px | §9 ruling 121 glyph sized as its icon slot (§3.28 Widget metrics: dismiss × 16)

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
