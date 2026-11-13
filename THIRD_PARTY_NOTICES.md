# Third-party notices

## Questionnaire fork

`packages/helm-ask-user-question/` vendors the published source of
`@juicesharp/rpiv-ask-user-question@2.9.0`, renamed privately to
`@neumie/helm-ask-user-question@2.9.0-helm.1` for the opt-in Remote integration.

- Upstream: <https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-ask-user-question>
- Copyright (c) 2026 juicesharp
- License: MIT; the full notice is retained at `packages/helm-ask-user-question/LICENSE`.
- Provenance, original source hash and modifications: `packages/helm-ask-user-question/FORK.md`.
- This is not a production package replacement or publication. Upstream source
  formatting is retained; the new `remote-answers.ts` module follows Helm lint rules.

HAPI was inspected as an architecture reference (AGPL-3.0). No HAPI source is
incorporated into Helm Remote.

## QR encoder and test decoder

Helm Remote uses the pinned `qrcode-generator@1.4.4` package only to render the
one-time local TTY pairing matrix. The focused test uses pinned `jsqr@1.4.0` to
decode that rendered matrix independently; neither package receives pairing
credentials outside the intentional local command/test.

- QR encoder: <https://github.com/kazuhikoarase/qrcode-generator> — MIT
- QR decoder: <https://github.com/cozmo/jsQR> — Apache-2.0

## Markdown parser

Remote uses exactly pinned `marked@18.0.11` (MIT, Christopher Jeffrey and contributors): <https://github.com/markedjs/marked>. The complete package license ships in its dependency distribution. Helm uses its lexer only, rendering an explicit React element allowlist instead of generated HTML; images never trigger network requests. The package manager's minimum-release-age policy remains enabled.

## PDF viewer (pdf.js and its data)

`helm open` shows PDFs with exactly pinned `pdfjs-dist@6.4.299` (Mozilla Foundation, Apache-2.0): <https://github.com/mozilla/pdf.js>. The app bundle also ships the package's optional data, each with its license text under `dist/viewer/assets/pdfjs/licenses/`:

- Character maps (`cmaps/`): Adobe Systems Incorporated, BSD-3-Clause.
- Standard fonts (`standard_fonts/`): Foxit fonts from PDFium (BSD-3-Clause) and Liberation Sans (Red Hat, GPLv2 with the font embedding exceptions in `LICENSE_LIBERATION`).
- Wasm image decoders: `jbig2.wasm` (PDFium's JBIG2 decoder, BSD-3-Clause), `openjpeg.wasm` (OpenJPEG, BSD-2-Clause), `qcms_bg.wasm` (Mozilla qcms, MIT); their pdf.js build glue is Apache-2.0.
- ICC profile `CGATS001Compat-v2-micro.icc`: CC0-1.0.

Helm does not ship pdf.js's scripting sandbox (QuickJS) or the no-wasm JavaScript decoder fallbacks.

## Okena Claude Code preload

`app/src/claude-remote/preload.cjs` (the Bun `--preload` that adds Helm's Claude Code hooks to a Helm terminal's top-level interactive `claude`) is adapted from Okena's Claude Code preload (`preload.js`, revision ef25cc81) and its hook/dialog design (`decision.rs`, `hub.rs`): argv/entry gating, guarded flags and subcommands, and inline `--settings` injection. The hub protocol, tokens and decision encoding are Helm's own.

- Project: Okena — <https://github.com/contember/okena>
- Copyright (c) 2026 Contember Limited
- License: MIT (full text below, under Heroicons; identical terms with this copyright line)

## Heroicons (24px outline)

Helm draws every UI icon from one set, Heroicons v2.2.0 24px outline (docs/design-system.md §9 ruling 95). The path geometry is copied unchanged from <https://github.com/tailwindlabs/heroicons/tree/v2.2.0/src/24/outline>; Helm binds the stroke to `currentColor` and draws it with stroke width 2 (the published files use 1.5). The geometry and source of each icon live in the icon module, `app/src/renderer/icons/icons.ts` (entry name in parentheses):

- **Plus** (`plus`): <https://github.com/tailwindlabs/heroicons/blob/v2.2.0/src/24/outline/plus.svg>
- **Bars 2** (`menu`): <https://github.com/tailwindlabs/heroicons/blob/v2.2.0/src/24/outline/bars-2.svg>
- **Chevron Left** (`back`): <https://github.com/tailwindlabs/heroicons/blob/v2.2.0/src/24/outline/chevron-left.svg>
- **Chevron Right** (`chevronRight`): <https://github.com/tailwindlabs/heroicons/blob/v2.2.0/src/24/outline/chevron-right.svg>
- **Chevron Down** (`chevronDown`): <https://github.com/tailwindlabs/heroicons/blob/v2.2.0/src/24/outline/chevron-down.svg>
- **Ellipsis Horizontal** (`ellipsis`): <https://github.com/tailwindlabs/heroicons/blob/v2.2.0/src/24/outline/ellipsis-horizontal.svg>
- **Arrow Top Right on Square** (`external`): <https://github.com/tailwindlabs/heroicons/blob/v2.2.0/src/24/outline/arrow-top-right-on-square.svg>
- **Square 2 Stack** (`copy`): <https://github.com/tailwindlabs/heroicons/blob/v2.2.0/src/24/outline/square-2-stack.svg>
- **Check** (`check`): <https://github.com/tailwindlabs/heroicons/blob/v2.2.0/src/24/outline/check.svg>
- **CPU Chip** (`agent`): <https://github.com/tailwindlabs/heroicons/blob/v2.2.0/src/24/outline/cpu-chip.svg>
- **User** (`manual`): <https://github.com/tailwindlabs/heroicons/blob/v2.2.0/src/24/outline/user.svg>
- **Play** (`play`): <https://github.com/tailwindlabs/heroicons/blob/v2.2.0/src/24/outline/play.svg>
- **Arrow Down Tray** (`queue`): <https://github.com/tailwindlabs/heroicons/blob/v2.2.0/src/24/outline/arrow-down-tray.svg>
- **Arrow Path** (`retry`): <https://github.com/tailwindlabs/heroicons/blob/v2.2.0/src/24/outline/arrow-path.svg>
- **Stop** (`stop`): <https://github.com/tailwindlabs/heroicons/blob/v2.2.0/src/24/outline/stop.svg>
- **Pause** (`pause`): <https://github.com/tailwindlabs/heroicons/blob/v2.2.0/src/24/outline/pause.svg>
- **Arrow Uturn Left** (`return`): <https://github.com/tailwindlabs/heroicons/blob/v2.2.0/src/24/outline/arrow-uturn-left.svg>
- **Document Text** (`plan`): <https://github.com/tailwindlabs/heroicons/blob/v2.2.0/src/24/outline/document-text.svg>
- **Archive Box** (`archive`): <https://github.com/tailwindlabs/heroicons/blob/v2.2.0/src/24/outline/archive-box.svg>
- **Calendar Days** (`calendar`): <https://github.com/tailwindlabs/heroicons/blob/v2.2.0/src/24/outline/calendar-days.svg>
- **Cog 6 Tooth** (`settings`): <https://github.com/tailwindlabs/heroicons/blob/v2.2.0/src/24/outline/cog-6-tooth.svg>
- **X Mark** (`close`): <https://github.com/tailwindlabs/heroicons/blob/v2.2.0/src/24/outline/x-mark.svg>
- **Arrow Up** (`arrowUp`): <https://github.com/tailwindlabs/heroicons/blob/v2.2.0/src/24/outline/arrow-up.svg>
- **Arrow Down** (`arrowDown`): <https://github.com/tailwindlabs/heroicons/blob/v2.2.0/src/24/outline/arrow-down.svg>
- **Chat Bubble Left Ellipsis** (`chatBubbleLeftEllipsis`): <https://github.com/tailwindlabs/heroicons/blob/v2.2.0/src/24/outline/chat-bubble-left-ellipsis.svg>
- Terminal groups — **Folder** (`folder`): <https://github.com/tailwindlabs/heroicons/blob/v2.2.0/src/24/outline/folder.svg>
- Background terminals — **Arrow Down on Square Stack** (`backgroundStack`; `app/src/renderer/index.html` keeps a static first-paint copy, held equal by `tests/design-icons.test.ts`): <https://github.com/tailwindlabs/heroicons/blob/v2.2.0/src/24/outline/arrow-down-on-square-stack.svg>
- Task sidebar toggle — **View Columns** (`sidebarToggle`): <https://github.com/tailwindlabs/heroicons/blob/v2.2.0/src/24/outline/view-columns.svg>

Copies outside the module, same set and stroke:

- Select chevron — **Chevron Down**, the `.select` data URI in `app/src/renderer/sidebar/sidebar.css`: <https://github.com/tailwindlabs/heroicons/blob/v2.2.0/src/24/outline/chevron-down.svg>
- Extension model picker — **Chevron Down** and **Check** in `extension/src/Widget.tsx`: <https://github.com/tailwindlabs/heroicons/blob/v2.2.0/src/24/outline/chevron-down.svg>, <https://github.com/tailwindlabs/heroicons/blob/v2.2.0/src/24/outline/check.svg>

One app icon asset keeps the 16px solid style:

- Remote PWA launcher — **Command Line**, v2.2.0, exact source `app/assets/remote/command-line.svg`; generated PNGs use Helm colors and mask-safe padding: <https://github.com/tailwindlabs/heroicons/blob/v2.2.0/optimized/16/solid/command-line.svg>

- Project: <https://heroicons.com>
- Copyright © Tailwind Labs, Inc.
- License: MIT

### MIT License

Copyright (c) Tailwind Labs, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
