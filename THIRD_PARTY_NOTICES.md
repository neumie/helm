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

## Heroicons (16px solid)

Helm vendors native-size Heroicons for distinct concepts:

- Terminal groups — **Folder**: <https://github.com/tailwindlabs/heroicons/blob/616b7a4dbbf3d011760af8066262cd5c6b3868f3/optimized/16/solid/folder.svg>
- Background terminals — **Arrow Down on Square Stack**: <https://github.com/tailwindlabs/heroicons/blob/616b7a4dbbf3d011760af8066262cd5c6b3868f3/optimized/16/solid/arrow-down-on-square-stack.svg>
- Scheduled runs — **Calendar Days**: <https://github.com/tailwindlabs/heroicons/blob/616b7a4dbbf3d011760af8066262cd5c6b3868f3/optimized/16/solid/calendar-days.svg>
- Remote composer send — **Arrow Up**, v2.2.0, exact geometry in `app/src/renderer/remote/RemoteArrow.tsx`: <https://github.com/tailwindlabs/heroicons/blob/v2.2.0/optimized/16/solid/arrow-up.svg>
- Remote navigation drawer — **Bars 2**, v2.2.0, exact geometry in `app/src/renderer/sidebar/ui.tsx`: <https://github.com/tailwindlabs/heroicons/blob/v2.2.0/optimized/16/solid/bars-2.svg>
- Remote latest-message navigation — **Arrow Down**, v2.2.0, same module: <https://github.com/tailwindlabs/heroicons/blob/v2.2.0/optimized/16/solid/arrow-down.svg>
- Remote PWA launcher — **Command Line**, v2.2.0, exact source `app/assets/remote/command-line.svg`; generated PNGs use Helm colors and mask-safe padding: <https://github.com/tailwindlabs/heroicons/blob/v2.2.0/optimized/16/solid/command-line.svg>
- Remote session favorites — **Star**, v2.2.0, exact geometry in `app/src/renderer/remote/RemoteFavoriteStar.tsx`: <https://github.com/tailwindlabs/heroicons/blob/v2.2.0/optimized/16/solid/star.svg>
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
