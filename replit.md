# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.

## Artifacts

### linux-vm (web)
Browser-based v86 x86 emulator host. Boots ISO images (Arch, Alpine, FreeDOS, Linux 4 demo, KolibriOS) streamed on demand via the api-server proxy.

- v86 runtime: assets in `artifacts/linux-vm/public/v86/` (libv86.js, v86.wasm, seabios.bin, vgabios.bin from `v86@0.5.334`)
- ISO catalog & proxy: `artifacts/api-server/src/routes/iso.ts` — HEAD + GET range requests with CORS / `Cross-Origin-Resource-Policy: cross-origin` for COEP-isolated frontend
- Persistence: machine snapshots and per-ISO disk images in IndexedDB (`linux-vm-state` DB, stores `states` and `disks`); see `artifacts/linux-vm/src/lib/stateStore.ts`
- Networking: optional WebSocket relay (`wss://relay.widgetry.org/`)
- Disk model: in-memory `ArrayBuffer` allocated at boot (default 2 GB, hard cap ~4 GB due to browser ArrayBuffer limits), persisted to IndexedDB on Power off / Save state. Re-used on next boot of the same ISO so installs survive page reloads.
- COOP/COEP: vite.config.ts sets `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` so the WASM gets `SharedArrayBuffer` for full speed.

### api-server (api)
Express 5 API server. ISO proxy lives at `/api/iso/list` and `/api/iso/:id`.

### mockup-sandbox (design)
Component preview sandbox.
