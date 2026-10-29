# Purge managed-restart fixtures

These source fixtures come from [YuJunZhiXue/dsh-purge](https://github.com/YuJunZhiXue/dsh-purge) version **1.1.82**, commit [`0c933dc7d3252698f3f0f9756932dcc88355f532`](https://github.com/YuJunZhiXue/dsh-purge/commit/0c933dc7d3252698f3f0f9756932dcc88355f532).

`web.js`, `uninstall.js`, and `continue-retry.js` are unchanged upstream files. `uninstall-http-handler.js` is the unchanged `/dsh-purge/uninstall` handler excerpt from `lib/index.js` at that commit. The restart and uninstall fixtures are evaluated in a VM with fake process, filesystem, timer, and spawn APIs. The continue/retry fixture runs with a synthetic context, fake settings, virtual retry delays, and no network path. Tests never import an installed Purge package or start DSH.

The original Apache-2.0 `LICENSE` and upstream `NOTICE` are retained here. Attribution remains with the upstream author; the managed-restart guards are local changes applied by `scripts/patch-mac-dsh-purge.mjs`.

| File | Original SHA-256 |
| --- | --- |
| `web.js` | `e715a801eb98b176e5e455bada74cb540cee99959ee015dd5ae4155a2070b02c` |
| `uninstall.js` | `711877aa432b176c5f382dd7bf08c337fbe3df2e5b9790048ebcb0c7a5084cfb` |
| `continue-retry.js` | `b4710fb4eb9990801756e5396f447f9da227177db78d3fff4880509d527be6d0` |
