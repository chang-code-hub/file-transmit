# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

文件传输工具 (File Transmission Tool) — a self-hosted file transfer web application. Users upload files, get an 8-character ID, and share that ID for others to download.

## Commands

```bash
npm run dev          # Start both frontend (Vite :5173) and backend (Express :3000) with hot reload
npm run build        # Build React frontend to client/dist/
npm start            # Production: serve built frontend + API from Express on port 3000
npm run dev:server   # Start only backend with nodemon
npm run dev:client   # Start only Vite dev server
```

- `scripts/start.bat` — Windows one-click launcher (auto-installs deps, builds, starts)
- `scripts/start.sh` — Linux one-click launcher
- `scripts/install-service.bat` — Install as Windows service (run as Administrator)
- `scripts/uninstall-service.bat` — Remove Windows service

There are no tests yet.

## Architecture

```
file-transmit/
├── server/
│   ├── index.js              # Express entry: middleware stack, API mount, static file serve, startup
│   ├── config.js             # Reads/writes config.json, sets defaults, creates storage dir
│   ├── db.js                 # better-sqlite3: schema init (files, file_records, settings tables), all queries
│   ├── middleware/
│   │   ├── userId.js         # Sets permanent cookie `file_transmit_uid` (UUID v4, 1yr expiry) on first visit
│   │   ├── ipFilter.js       # Factory fn(mode): checks client IP against config.ipFilter[mode] allowlist/blocklist
│   │   └── auth.js           # Verifies x-admin-password header against config.adminPassword
│   ├── routes/
│   │   ├── admin.js          # POST /api/admin/login, GET/PUT /api/admin/settings, GET /api/admin/stats
│   │   ├── upload.js         # POST /api/upload/files (multer), GET /api/upload/history, GET /api/upload/validate-ids
│   │   └── download.js       # GET /api/download/:fileId (detail), GET /api/download/:fileId/:fileName (download)
│   ├── services/
│   │   ├── cleanup.js        # setInterval (30min): deletes expired files+folders+DB records, removes empty dirs
│   │   └── avScan.js         # Windows-only: spawns Huorong HipsMain.exe -s <path>; no-op on Linux
│   └── utils/
│       └── ipMatch.js        # Test IP against CIDR, hyphen-range, or exact-match expressions
├── client/
│   ├── vite.config.js        # Vite with React plugin, proxies /api to localhost:3000
│   └── src/
│       ├── App.jsx           # HashRouter with three routes, top nav
│       ├── pages/
│       │   ├── UploadPage.jsx     # Drag-drop zone, multi-file select, auto-rename dupes, description, history
│       │   ├── DownloadPage.jsx   # Single ID input → opens FileDetailModal
│       │   └── AdminPage.jsx      # Password gate → all settings (file types, IP filters, storage, antivirus)
│       └── components/
│           ├── PasswordModal.jsx   # Reusable admin login modal
│           ├── FileDetailModal.jsx # File metadata + file list with download links
│           └── HistoryButton.jsx   # Reads IDs from localStorage, validates against server, shows list
├── config.json              # Runtime config (password, storagePath, retentionHours, file types, IP rules)
└── scripts/                 # start/install-service/uninstall-service (.bat + .sh)
```

### Key Design Decisions

- **HashRouter** (not BrowserRouter) — avoids server-side fallback complexity for SPA routing
- **better-sqlite3** — synchronous API, no connection pool needed for single-server use
- **File storage**: each upload gets a folder named by its 8-char ID under `config.storagePath`
- **Settings** are dual-stored: `config.json` on disk + `settings` table in SQLite (config.json is the source of truth, loaded at startup)
- **No authentication framework** — admin auth is a simple password header check; user identity is a permanent UUID cookie
- **Vite proxy** in dev mode forwards `/api` requests to Express; in production Express serves `client/dist/` directly
