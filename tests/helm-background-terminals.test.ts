import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const renderer = readFileSync(new URL('../app/src/renderer/renderer.ts', import.meta.url), 'utf8')
const html = readFileSync(new URL('../app/src/renderer/index.html', import.meta.url), 'utf8')
const normalizedHtml = html.replace(/\s+/g, ' ')
const css = readFileSync(new URL('../app/src/renderer/styles.css', import.meta.url), 'utf8')
const thirdPartyNotices = readFileSync(new URL('../THIRD_PARTY_NOTICES.md', import.meta.url), 'utf8')

function functionSlice(name: string, nextName: string): string {
	const start = renderer.indexOf(`function ${name}`)
	const end = nextName ? renderer.indexOf(`function ${nextName}`, start) : renderer.length
	return renderer.slice(start, end)
}

test('opening a background terminal activates it without restoring ownership', () => {
	const open = functionSlice('openParked', 'restoreParked')
	assert.match(open, /parked\.includes\(tab\)/)
	assert.match(open, /activate\(tab\)/)
	assert.doesNotMatch(open, /parked\.splice|setParked|tab\.parked\s*=/)

	const restore = functionSlice('restoreParked', 'killParkedTab')
	assert.match(restore, /parked\.splice/)
	assert.match(restore, /tab\.parked = false/)
	assert.match(restore, /targetOrder\.every\(candidate => tabs\.includes\(candidate\)\)/)
	assert.ok(restore.indexOf('tabs.splice(0, tabs.length, ...targetOrder)') < restore.indexOf('renderTabGroups()'))
	assert.match(restore, /setParked\(tab\.sessionId, false\)/)
})

test('background strip uses the selected native 16px Heroicons down-to-stack glyph', () => {
	assert.match(normalizedHtml, /<svg class="background-icon" width="16" height="16" viewBox="0 0 16 16"/)
	assert.match(normalizedHtml, /fill="currentColor"/)
	assert.match(normalizedHtml, /M7 1a\.75\.75 0 0 1 \.75\.75V6/)
	assert.match(normalizedHtml, /M4\.268 14A2 2 0 0 0 6 15h6/)
	assert.doesNotMatch(normalizedHtml, /M3 2a1 1 0 0 0-1 1v1/)
	assert.doesNotMatch(normalizedHtml, /stroke-width=/)
	assert.match(thirdPartyNotices, /Heroicons/)
	assert.match(thirdPartyNotices, /Arrow Down on Square Stack/)
	assert.match(thirdPartyNotices, /MIT License/)
})

test('strip control names the currently open background terminal', () => {
	assert.match(normalizedHtml, /<span id="bg-current" class="bg-current" hidden><\/span>/)
	const activate = functionSlice('activate', 'cycleTab')
	const update = functionSlice('updateBackgroundUi', 'renderBackgroundRows')
	assert.match(activate, /updateBackgroundUi\(\)/)
	assert.match(update, /const opened = activeTab\?\.parked \? activeTab : null/)
	assert.match(update, /const openedName = opened \? displayName\(opened\) : null/)
	assert.match(update, /bgCurrent\.hidden = openedName === null/)
	assert.match(update, /bgCurrent\.textContent = openedName \?\? ''/)
	assert.match(update, /bgToggle\.title = openedName \? `Background terminals — viewing \$\{openedName\}`/)
	assert.match(update, /bgToggle\.setAttribute\('aria-label', bgToggle\.title\)/)
	assert.match(css, /\.bg-current\s*\{[^}]*max-width:\s*min\(160px, 25vw\)/s)
	assert.match(css, /\.bg-current\s*\{[^}]*text-overflow:\s*ellipsis/s)
	assert.match(css, /\.bg-current\[hidden\]\s*\{[^}]*display:\s*none/s)
})

test('background groups use a flat full-width section row instead of the strip pill', () => {
	assert.match(css, /\.bg-group-section\s*\{[^}]*box-shadow:\s*inset 2px 0/s)
	assert.match(
		css,
		/\.bg-group-header-row > \.tab-group-toggle\s*\{[^}]*width:\s*100%[^}]*height:\s*44px[^}]*padding:\s*0[^}]*background:\s*transparent[^}]*box-shadow:\s*none/s,
	)
	assert.match(css, /\.bg-group-header-row > \.tab-group-toggle \.tab-group-summary\s*\{[^}]*padding:\s*0/s)
	assert.match(css, /\.bg-group-header-row > \.tab-group-toggle \.tab-group-count\s*\{[^}]*margin-left:\s*auto/s)
	assert.match(css, /\.bg-group-header-row > \.tab-group-toggle \.tab-group-count\s*\{[^}]*border-left:\s*0/s)
	assert.doesNotMatch(css, /\.bg-group-header-row > \.tab-group-toggle\s*\{[^}]*box-shadow:\s*inset 0 2px/s)
	assert.doesNotMatch(css, /\.bg-group-header-row\s*\{[^}]*margin:/s)
	assert.match(renderer, /if \(section\.collapsed \|\| section\.surface === 'background'\)/)
})

test('background group headers expose Restore all without a context menu', () => {
	const header = functionSlice('groupHeader', 'focusedGroupHeader')
	assert.match(header, /section\.surface !== 'background'\) return toggle/)
	assert.match(header, /row\.className = 'bg-group-header-row'/)
	assert.match(header, /section\.actionTargets\.find\(target => target\.action === 'restore'\)/)
	assert.match(
		header,
		/createIconButton\(\{[\s\S]*label: `Restore \$\{section\.name\} group to tabs`[\s\S]*glyph: '⇥'[\s\S]*onClick: \(\) => runGroupAction\(restoreTarget\)/,
	)
	assert.match(
		css,
		/\.bg-group-header-row\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*minmax\(0, 1fr\) 28px 28px[^}]*gap:\s*4px[^}]*width:\s*100%[^}]*height:\s*44px[^}]*padding:\s*0 12px/s,
	)
	assert.match(
		css,
		/\.bg-group-header-row:hover\s*\{[^}]*background:\s*color-mix\(in srgb, var\(--group-color\) 12%, transparent\)/s,
	)
	assert.doesNotMatch(css, /\.bg-group-header-row > \.tab-group-toggle:hover\s*\{[^}]*background:/s)
	assert.match(css, /\.bg-group-header-row > \.tab-group-toggle \.tab-group-count\s*\{[^}]*margin-left:\s*auto/s)
	assert.match(css, /\.bg-group-restore\s*\{[^}]*color:\s*color-mix\([^;]*var\(--group-color\)/s)
	assert.match(css, /\.bg-group-close-slot\s*\{[^}]*width:\s*28px[^}]*height:\s*28px/s)
	assert.match(header, /closeSlot\.className = 'bg-group-close-slot'/)
	assert.match(header, /row\.append\(toggle, restore, closeSlot\)/)
})

test('background terminal title target drags directly back to the strip', () => {
	const rows = functionSlice('renderBackgroundRows', 'openBackgroundPopover')
	const target = functionSlice('updateBackgroundTabDragTarget', 'backgroundTabDragFrame')
	const start = functionSlice('startBackgroundTabPointerDrag', 'removeBackgroundTabPointerListeners')
	const projection = functionSlice('createTabStripProjection', 'clearBackgroundTabDropTarget')
	const finish = functionSlice('finishBackgroundTabPointerDrag', 'onBackgroundTabPointerMove')
	assert.match(
		rows,
		/open\.addEventListener\('pointerdown', event => beginBackgroundTabPointerDrag\(tab, open, event\)\)/,
	)
	assert.match(rows, /open\.title = 'Open and keep in background · Drag to tabs'/)
	assert.match(rows, /if \(suppressTabClick\.has\(tab\)\) return/)
	assert.match(normalizedHtml, /id="tab-strip-region" class="topbar-right"/)
	assert.match(target, /const stripRect = tabStripRegion\.getBoundingClientRect\(\)/)
	assert.doesNotMatch(target, /const stripRect = tabsEl\.getBoundingClientRect\(\)/)
	assert.match(target, /placeBackgroundTabPlaceholder\(drag, units, groupedPeers\)/)
	assert.match(projection, /tab\.tabButton\.cloneNode\(true\)/)
	assert.match(projection, /clone\.classList\.add\('active'/)
	assert.match(start, /createTabStripProjection\(drag\.tab, 'background-tab-drag-preview'/)
	assert.match(start, /createTabStripProjection\(drag\.tab, 'background-tab-drop-placeholder'/)
	assert.doesNotMatch(start, /Math\.min\(Math\.max\(rect\.width, 120\), 180\)/)
	assert.doesNotMatch(start, /placeholder\.style\.width|preview\.style\.width/)
	assert.match(start, /tabStripRegion\.classList\.add\('background-restore-ready'\)/)
	assert.ok(start.indexOf("classList.add('background-restore-ready')") < start.indexOf('closeBackgroundPopover()'))
	assert.match(start, /closeBackgroundPopover\(\)/)
	assert.match(start, /preview\.classList\.add\('tab-drag-preview'\)/)
	assert.match(finish, /drag\.dropTarget === 'strip'/)
	assert.match(finish, /const nextOrder = backgroundTabRestoreOrder\(drag\)/)
	assert.match(finish, /restoreParked\(drag\.tab, nextOrder\)/)
	assert.doesNotMatch(finish, /setTabOrder|persistTerminalOrder/)
	assert.match(renderer, /drag\.tab\.groupId \? tabs\.filter\(tab => tab\.groupId === drag\.tab\.groupId\) : \[\]/)
	assert.doesNotMatch(finish, /setMembership|groups\.intent/)
	assert.match(
		css,
		/\.background-tab-drop-placeholder,\s*\.tab-group-section\.group-drop-placeholder\s*\{[^}]*opacity:\s*0\.58/s,
	)
	assert.doesNotMatch(css, /\.background-tab-drop-placeholder(?:,|\s*\{)[^}]*background:/s)
	assert.match(css, /\.tab-group-section\.background-tab-drop-target\s*\{[^}]*var\(--group-color\) 22%/s)
	assert.match(css, /\.topbar-right\.background-restore-over\s*\{[^}]*background:/s)
	assert.match(finish, /tabStripRegion\.classList\.remove\('background-restore-ready'\)/)
})

test('background groups and terminals share the full strip receiver and exact destination geometry', () => {
	const update = functionSlice('updateGroupDragTarget', 'groupDragFrame')
	const projection = functionSlice('createProjectedStripGroup', 'placeProjectedStripGroup')
	const place = functionSlice('placeProjectedStripGroup', 'markGroupDragPlaceholder')
	const mark = functionSlice('markGroupDragPlaceholder', 'positionGroupPreview')
	const start = functionSlice('startGroupPointerDrag', 'removeGroupPointerListeners')
	const reset = functionSlice('resetGroupDragChrome', 'finishGroupBackgroundDrop')
	const finish = functionSlice('finishGroupStripRestore', 'finishGroupPointerDrag')
	assert.match(update, /const stripRect = tabStripRegion\.getBoundingClientRect\(\)/)
	assert.doesNotMatch(update, /const stripRect = tabsEl\.getBoundingClientRect\(\)/)
	assert.match(update, /tabStripRegion\.classList\.add\('background-restore-over'\)/)
	assert.match(update, /placeProjectedStripGroup\(drag, units\)/)
	assert.match(projection, /const stripSource = composition\.strip\.find/)
	assert.match(projection, /const members = \[\.\.\.\(stripSource\?\.members \?\? \[\]\), \.\.\.source\.members\]/)
	assert.match(projection, /createStripSection\(projected, byId, true\)/)
	assert.match(projection, /collapsed: group\.collapsedStrip/)
	assert.match(projection, /placeholder\.inert = true/)
	assert.match(projection, /querySelectorAll<HTMLElement>\('\[id\], button, \[tabindex\]'\)/)
	assert.match(place, /const target = units\[drag\.dropUnitIndex\]\?\.element \?\? null/)
	assert.match(place, /tabsEl\.insertBefore\(placeholder, target\)/)
	assert.match(
		mark,
		/if \(drag\.originSurface === 'background'\) stripGroupElement\(drag\.groupId\)\?\.classList\.add\('group-drag-placeholder'\)/,
	)
	assert.match(start, /drag\.placeholder = createProjectedStripGroup\(drag\)/)
	assert.match(start, /tabStripRegion\.classList\.add\('background-restore-ready'\)/)
	assert.match(finish, /const restoredMembers = tabs\.filter\(tab => tab\.groupId === drag\.groupId\)/)
	assert.match(finish, /restoredMembers,/)
	assert.match(reset, /tabStripRegion\.classList\.remove\('background-restore-ready', 'background-restore-over'\)/)
	assert.match(css, /\.tab-group-section\.group-drop-placeholder\s*\{[^}]*opacity:\s*0\.58/s)
})

test('background rows form an editorial list with explicit icon actions', () => {
	const render = functionSlice('renderBackgroundRows', 'onBgOutside')
	assert.match(render, /open\.addEventListener\('click', \(\) => \{[\s\S]*openParked\(tab\)[\s\S]*\}\)/)
	assert.match(
		render,
		/createIconButton\(\{[\s\S]*label: `Move \$\{displayName\(tab\)\} to tabs and open`[\s\S]*glyph: '⇥'/,
	)
	assert.match(render, /onClick: \(\) => restoreParked\(tab\)/)
	assert.match(render, /createIconButton\(\{[\s\S]*label: `Close \$\{displayName\(tab\)\}`[\s\S]*glyph: '×'/)
	assert.match(render, /onClick: \(\) => killParkedTab\(tab\)/)
	assert.doesNotMatch(render, /restore\.className|kill\.className/)
	assert.match(normalizedHtml, /aria-haspopup="dialog"/)
	assert.doesNotMatch(normalizedHtml, /bg-header-count/)
	assert.doesNotMatch(renderer, /bgHeaderCount/)
	assert.doesNotMatch(css, /\.bg-header-count/)
	assert.match(normalizedHtml, /<div class="bg-header">Background terminals<\/div>/)
	assert.match(css, /#bg-popover\s*\{[^}]*top:\s*calc\(100% \+ 5px\)/s)
	assert.match(css, /#bg-popover\s*\{[^}]*width:\s*320px/s)
	assert.match(css, /#bg-popover\s*\{[^}]*max-height:\s*min\(480px, calc\(100vh - 48px\)\)/s)
	assert.match(css, /#bg-popover\s*\{[^}]*padding:\s*0/s)
	assert.match(css, /\.bg-header\s*\{[^}]*padding:\s*8px 12px/s)
	assert.match(css, /#bg-rows\s*\{[^}]*overflow-y:\s*auto/s)
	assert.match(css, /\.bg-row\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto auto/s)
	assert.match(css, /\.bg-row\s*\{[^}]*min-height:\s*44px/s)
	assert.match(css, /\.bg-row\s*\{[^}]*width:\s*100%/s)
	assert.doesNotMatch(css, /\.bg-row\s*\{[^}]*margin:/s)
	assert.match(css, /\.bg-row\s*\{[^}]*border-radius:\s*0/s)
	assert.match(css, /\.bg-open\s*\{[^}]*display:\s*flex/s)
	assert.match(css, /\.bg-open-copy\s*\{[^}]*display:\s*grid/s)
})

test('background popover catches a click on native titlebar whitespace', () => {
	assert.match(normalizedHtml, /<div id="topbar-drag-space" class="topbar-drag-space" aria-hidden="true"\s*><\/div>/)
	assert.match(
		css,
		/\.topbar-drag-space\.popover-catcher,\s*\.topbar-right\.background-restore-ready \.topbar-drag-space\s*\{[^}]*-webkit-app-region:\s*no-drag/s,
	)
	const outside = functionSlice('onBgOutside', 'onBgKeydown')
	const open = functionSlice('openBackgroundPopover', 'closeBackgroundPopover')
	const close = functionSlice('closeBackgroundPopover', '')
	assert.match(outside, /event\.target === topbarDragSpace/)
	assert.match(outside, /bgToggle\.focus\(\)/)
	assert.match(open, /topbarDragSpace\.classList\.add\('popover-catcher'\)/)
	assert.match(close, /topbarDragSpace\.classList\.remove\('popover-catcher'\)/)
})

test('background rows show only protocol-owned agent state', () => {
	const render = functionSlice('renderBackgroundRows', 'onBgOutside')
	assert.match(render, /tab\.agentRunning \|\| tab\.agentAttention/)
	assert.match(render, /createActivityIndicator/)
	assert.match(render, /const exitedState = tab\.exitCode === null \? null : `Exited \(\$\{tab\.exitCode\}\)`/)
	assert.match(render, /agentState/)
	assert.doesNotMatch(render, /['"]Running['"]/)
	assert.doesNotMatch(render, /bg-activity-slot/)
	assert.match(render, /if \(exitedState\)/)
	assert.doesNotMatch(renderer, /bg-dot|activityMuteUntil|Output after parking lights/)
	assert.match(renderer, /if \(tab\.parked\) updateBackgroundUi\(\)/)
	assert.match(renderer, /if \(activeTab\.parked\) killParkedTab\(activeTab\)/)
})

test('background rows collapse idle live terminals to one compact line', () => {
	assert.match(css, /\.bg-row\s*\{[^}]*min-height:\s*44px/s)
	assert.match(css, /\.bg-open\s*\{[^}]*display:\s*flex/s)
	assert.doesNotMatch(css, /\.bg-activity-slot\s*\{/)
})

test('closing the final background row moves focus before hiding the control', () => {
	const update = functionSlice('updateBackgroundUi', 'renderBackgroundRows')
	assert.match(update, /const focusWasInPopover = empty && bgPopover\.contains\(document\.activeElement\)/)
	assert.match(update, /if \(focusWasInPopover\) newTabButton\.focus\(\)/)
})
