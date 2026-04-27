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
- Persistence:
  - Machine snapshots (CPU + RAM + disk) in IndexedDB (`linux-vm-state` DB, store `states`); see `artifacts/linux-vm/src/lib/stateStore.ts`
  - Sparse virtual disks in IndexedDB (`linux-vm-disks` DB, stores `meta` + `blocks`, 256 KB chunks per ISO); see `artifacts/linux-vm/src/lib/indexedDbDisk.ts`. Implements v86's storage backend (`byteLength`/`load`/`get`/`set`/`get_state`/`set_state`/`get_buffer`) with an in-memory LRU and 1 s debounced flush.
- Networking: optional WebSocket relay (`wss://relay.widgetry.org/`)
- Disk model: chunked sparse disk backed by IndexedDB (default 50 GB, max 50 GB). Only blocks the guest actually writes consume browser storage. Disk data persists continuously between boots of the same ISO. Snapshots that include the full disk are limited to disks ≤ 4 GB (`SAVE_STATE_DISK_LIMIT_GB`); above that the Save state button is disabled with a tooltip — disk persistence still works.
- COOP/COEP: vite.config.ts sets `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` so the WASM gets `SharedArrayBuffer` for full speed.

### api-server (api)
Express 5 API server. ISO proxy lives at `/api/iso/list` and `/api/iso/:id`.

### mockup-sandbox (design)
Component preview sandbox.
