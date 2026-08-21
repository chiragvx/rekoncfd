# Rekon CFD

Local RC-flying-wing aerodynamic analysis tool: a Rust backend (Axum + WebSocket)
serving a Three.js browser UI. Combines a live 3D panel method (CL/CD/Cm/trim) with
an on-demand 3D Lattice Boltzmann flow-field solver.

See `crates/`, `web/`, and the workspace `Cargo.toml` for structure.

## Build order

`rekon-app` embeds the built frontend (`web/dist`) into the binary at compile time
via `rust-embed`, so **the frontend must be built before the Rust binary**:

```sh
cd web
npm install
npm run build
cd ..
cargo run -p rekon-app
```

This produces a single process serving everything on `http://127.0.0.1:3000` and
auto-launches your default browser to it.

## Frontend development

For fast iteration on the UI (HMR, no Rust rebuild needed), run the Vite dev
server alongside the backend — it proxies `/ws` and `/api` through to Axum:

```sh
cargo run -p rekon-app     # terminal 1 — backend on :3000
cd web && npm run dev      # terminal 2 — frontend on its own port, proxied
```

Rebuild `web/dist` (`npm run build`) before shipping a release binary so the
embedded assets reflect the latest frontend changes.

## Releases & self-update

The desktop `.exe` checks GitHub Releases on launch (`GET /api/version`,
implemented in `crates/rekon-app/src/updater.rs` via the `self_update` crate)
and can download+install a newer release over itself (`POST
/api/update/apply`) without the user ever re-downloading it. A hosted web
deployment doesn't need any of this — it's just redeployed whenever we ship.

Both the Rust side (`crates/rekon-app/src/updater.rs`, `REPO_OWNER`/`REPO_NAME`)
and the frontend (`web/src/lib/release.ts`, `GITHUB_REPO`) point at
`chiragvx/rekoncfd`. Until that repo has an actual release, both fail closed
(404/network error), which reads as "no update available" / "check back
soon" rather than an error.

To cut a release:

1. `cargo build --release -p rekon-app` (after `npm run build` in `web/`, per above).
2. Tag it with a semver tag, e.g. `v0.2.0`.
3. Create a GitHub Release for that tag and upload
   `target/release/rekon-app.exe` renamed to
   **`rekon-app-x86_64-pc-windows-msvc.exe`** — the target-triple in the
   filename is what `self_update`'s asset matching (and the Download page's
   download link) both key off of. It must be the raw `.exe`, not a zip/tar —
   `self_update` copies it byte-for-byte with no archive step.
4. Bump `version` in the workspace `Cargo.toml` (`[workspace.package]`) to
   match the tag before the *next* release, so the version-check has
   something to compare against.
