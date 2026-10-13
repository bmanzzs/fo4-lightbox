# Rapier (vendored)

`rapier.mjs` is `dist/rapier.mjs` of the npm package `@dimforge/rapier3d-compat` 0.20.0, unchanged: the Rapier 3D
physics engine (https://rapier.rs, https://github.com/dimforge/rapier), with its WebAssembly inlined as base64 so it
loads offline (`init()` uses the inlined bytes; nothing is fetched). By Dimforge (Sébastien Crozet), Apache-2.0: see
`LICENSE`.

Taken on 2026-10-11 from https://registry.npmjs.org/@dimforge/rapier3d-compat/-/rapier3d-compat-0.20.0.tgz
(npm integrity `sha512-X4W9pJBdGRX5CO3c/gUNjBFEFG2fn4nYxp9k8STdBDaLa0/w5XTW2ArpayS+9jGFojTi3uFSOWAElCd4rkpekA==`, checked).

Used by `web/js/physics.js` for game mode collision, items dropped with physics and the collision view.
