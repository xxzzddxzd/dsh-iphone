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
