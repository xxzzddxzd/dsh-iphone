# Third-party notices

This repository contains integration code and patches. It does not vendor the
complete Node.js or DeepSeek Harness source trees, npm dependency trees, or
compiled binaries.

## DeepSeek Harness

- Project: <https://github.com/deepseek-ai/deepseek-harness>
- Pinned source: `upstream/deepseek-harness`
- License: MIT
- Copyright: DeepSeek Harness contributors

The upstream source is referenced as a Git submodule. Runtime packages are
downloaded from npm by the build scripts and retain their own license files.

## Node.js

- Project: <https://github.com/nodejs/node>
- Version: 22.23.2
- License: MIT and bundled third-party licenses

The build downloads the official source archive from nodejs.org and applies
`patches/node-v22.23.2-ios.patch`. The resulting archive and binary are not
tracked by this repository. See Node.js `LICENSE` in the downloaded source for
the complete notices.

## node-pty

- Project: <https://github.com/microsoft/node-pty>
- Version: 1.1.0
- License: MIT
- Copyright: Microsoft Corporation

`patches/node-pty-1.1.0-ios.patch` adapts the Unix backend to the iOS
`forkpty` path. The npm package retains its upstream license.

## pnpm

- Project: <https://github.com/pnpm/pnpm>
- Version: 10.34.5
- License: MIT

The build downloads the published npm archive, verifies its SHA-256 digest,
adds an iOS-only shebang-launch compatibility branch to pnpm's bundled
`cross-spawn`, and packages it with Node 22 launch wrappers. The installed
distribution retains pnpm's license and bundled third-party notices.

## Xray-core

- Project: <https://github.com/XTLS/Xray-core>
- Version: 26.3.27
- Source commit: `d2758a023cd7f4174a5a5fa4ff66e487d4342ba0`
- License: Mozilla Public License 2.0

The optional VLESS package downloads the tagged Xray-core source archive,
verifies its SHA-256 digest, and cross-compiles an unmodified iPhoneOS arm64
executable. The package installs the upstream `LICENSE` beside the example
configuration. Neither the archive nor the binary is tracked by this
repository.
