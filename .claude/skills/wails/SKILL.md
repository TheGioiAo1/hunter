---
name: wails
description: "Build desktop apps with Wails (Go + React). Use for Go bindings, frontend-backend communication, window management, native dialogs, system tray, events, build/packaging."
argument-hint: "[feature or pattern]"
metadata:
  author: claudex-kit
  version: "1.0.0"
---

# Wails — Go + React Desktop Apps

## When to use

- Create Go↔JS bindings (expose Go functions to frontend)
- Handle events (emit/subscribe between Go and React)
- Window management (resize, fullscreen, frameless)
- Native dialogs (open file, save file, message box)
- System tray, menus, keyboard shortcuts
- Build & package for Windows/macOS/Linux
- Wails v2 project structure and configuration

## Project Structure

```
myapp/
├── wails.json                  # Wails project config
├── main.go                     # Entry point, create app + bind structs
├── app.go                      # Main App struct (lifecycle hooks)
├── internal/
│   ├── services/               # Business logic (bound to frontend)
│   │   ├── file_service.go
│   │   ├── settings_service.go
│   │   └── ...
│   ├── models/                 # Shared data structs (auto-generated TS types)
│   │   ├── file.go
│   │   └── settings.go
│   └── database/               # Optional: local DB (SQLite via GORM, bbolt)
│       └── database.go
├── frontend/
│   ├── src/
│   │   ├── App.tsx
│   │   ├── main.tsx
│   │   ├── components/
│   │   ├── hooks/
│   │   │   └── useWails.ts     # Wails runtime hooks wrapper
│   │   └── pages/
│   ├── wailsjs/                # Auto-generated bindings (DO NOT edit)
│   ├── index.html
│   ├── package.json
│   └── vite.config.ts
├── build/
│   ├── appicon.png             # App icon (1024x1024)
│   ├── windows/                # Windows-specific resources
│   └── darwin/                 # macOS-specific resources
└── go.mod
```

## Architecture Rules

### Go Side (Backend)

- **App struct** in `app.go` — lifecycle hooks (OnStartup, OnShutdown, OnDomReady)
- **Service structs** — bound to frontend via `wails.Run(options)`, each service = a group of related functions
- Methods on bound structs **automatically** become callable from JS/TS
- Struct fields tagged with `json:"fieldName"` — auto-generates TypeScript types
- **NO HTTP server** — Wails bridges Go↔JS directly via IPC, not REST

### React Side (Frontend)

- Generated bindings in `frontend/wailsjs/go/` — import via `@wailsjs/go/`
- Runtime API in `frontend/wailsjs/runtime/` — import via `@wailsjs/runtime/`
- **Setup path alias** in `tsconfig.json` + `vite.config.ts` (see below)
- **No React Router needed** for simple apps — use state-based navigation
- For complex apps — use React Router with hash routing (`HashRouter`)
- Tailwind + shadcn/ui works perfectly in Wails frontend

### Path Alias Setup

Add `@wailsjs` alias so imports are clean regardless of file depth:

**tsconfig.json:**
```json
{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@wailsjs/*": ["wailsjs/*"]
    }
  }
}
```

**vite.config.ts:**
```typescript
import { resolve } from 'path'
import { defineConfig } from 'vite'

export default defineConfig({
  resolve: {
    alias: {
      '@wailsjs': resolve(__dirname, 'wailsjs'),
    },
  },
})
```

**Import examples:**
```typescript
// Go bindings
import { OpenFile, SaveFile } from '@wailsjs/go/services/FileService'
import { GetSettings } from '@wailsjs/go/main/App'
import { models } from '@wailsjs/go/models'

// Runtime API
import { EventsOn, EventsEmit, WindowSetTitle } from '@wailsjs/runtime/runtime'
```

### Communication

| Direction | Method |
|-----------|--------|
| React → Go | Call generated binding functions (async, returns Promise) |
| Go → React | `runtime.EventsEmit(ctx, "event-name", data)` |
| React → React | Normal React state / context |
| Go → Go | Normal Go function calls |

### Naming

- Go files: snake_case (`file_service.go`)
- Go structs/methods: PascalCase (`FileService`, `OpenFile`)
- TS imports: PascalCase matching Go (`import { OpenFile } from '@wailsjs/go/services/FileService'`)
- Events: kebab-case (`file-opened`, `settings-changed`)

## Key Config (`wails.json`)

```json
{
  "name": "MyApp",
  "outputfilename": "MyApp",
  "frontend:install": "npm install",
  "frontend:build": "npm run build",
  "frontend:dev:watcher": "npm run dev",
  "frontend:dev:serverUrl": "auto",
  "author": { "name": "Author", "email": "email@example.com" }
}
```

## Build & Package

```bash
# Dev mode (hot-reload frontend + Go rebuild)
wails dev

# Build production binary
wails build

# Build with platform-specific options
wails build -platform windows/amd64
wails build -platform darwin/universal    # macOS universal binary
wails build -platform linux/amd64

# NSIS installer (Windows)
wails build -nsis

# Generate TS bindings manually
wails generate module
```

## References

Load when details needed:

| File | Content |
|------|---------|
| `references/go-bindings.md` | App lifecycle, struct binding, type mapping, context usage, error handling |
| `references/frontend-patterns.md` | Runtime API, events, hooks, dialogs, window control, React integration |
