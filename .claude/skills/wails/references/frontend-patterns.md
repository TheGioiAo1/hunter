# Wails Frontend Patterns (React + TypeScript)

## Calling Go from React

```tsx
// Auto-generated bindings — import directly
import { OpenFile, SaveFile } from '@wailsjs/go/services/FileService'
import { GetSettings, UpdateSettings } from '@wailsjs/go/services/SettingsService'
// Auto-generated types
import { models } from '@wailsjs/go/models'

function FileEditor() {
  const [file, setFile] = useState<models.FileResult | null>(null)

  const handleOpen = async () => {
    try {
      const result = await OpenFile()
      if (result) setFile(result)
    } catch (err) {
      console.error('Failed to open file:', err)
    }
  }

  const handleSave = async () => {
    if (!file) return
    try {
      await SaveFile(file.path, file.content)
    } catch (err) {
      console.error('Failed to save:', err)
    }
  }

  return (
    <div>
      <button onClick={handleOpen}>Open</button>
      <button onClick={handleSave}>Save</button>
      {file && <textarea value={file.content} onChange={...} />}
    </div>
  )
}
```

## Wails Runtime API

```tsx
import {
  EventsOn,
  EventsOff,
  EventsEmit,
  WindowSetTitle,
  WindowMinimise,
  WindowMaximise,
  WindowToggleMaximise,
  WindowFullscreen,
  WindowUnfullscreen,
  Quit,
  Environment,
  ClipboardGetText,
  ClipboardSetText,
} from '@wailsjs/runtime/runtime'
```

## Events (Go → React)

```tsx
import { EventsOn, EventsOff } from '@wailsjs/runtime/runtime'

function StatusBar() {
  const [status, setStatus] = useState('')

  useEffect(() => {
    // Subscribe to Go events
    const cleanup = EventsOn('status-update', (message: string) => {
      setStatus(message)
    })

    return () => {
      // Unsubscribe on unmount
      cleanup()
    }
  }, [])

  return <div className="status-bar">{status}</div>
}
```

## Events (React → Go)

```tsx
import { EventsEmit } from '@wailsjs/runtime/runtime'

// Emit event to Go (if Go is listening via runtime.EventsOn)
function NotifyGo() {
  EventsEmit('frontend-action', { type: 'refresh', target: 'all' })
}
```

## Custom useWails Hook

```tsx
// hooks/useWails.ts
import { useEffect, useCallback, useState } from 'react'
import { EventsOn, EventsOff, Environment } from '@wailsjs/runtime/runtime'

// Subscribe to Wails events with auto-cleanup
export function useWailsEvent<T = any>(eventName: string, handler: (data: T) => void) {
  useEffect(() => {
    const cleanup = EventsOn(eventName, handler)
    return () => { cleanup() }
  }, [eventName, handler])
}

// Detect platform
export function usePlatform() {
  const [platform, setPlatform] = useState<string>('')

  useEffect(() => {
    Environment().then(env => setPlatform(env.platform))
  }, [])

  return platform // "windows" | "darwin" | "linux"
}

// Window title sync
export function useWindowTitle(title: string) {
  useEffect(() => {
    WindowSetTitle(title)
  }, [title])
}
```

## Custom Title Bar (Frameless Window)

```tsx
// components/TitleBar.tsx
import { WindowMinimise, WindowToggleMaximise, Quit } from '@wailsjs/runtime/runtime'

function TitleBar({ title }: { title: string }) {
  return (
    {/* data-wails-drag enables native window dragging */}
    <div
      data-wails-drag
      className="flex items-center justify-between h-8 bg-gray-900 text-white select-none"
    >
      <span className="ml-3 text-sm">{title}</span>

      {/* data-wails-no-drag prevents drag on buttons */}
      <div data-wails-no-drag className="flex">
        <button
          onClick={() => WindowMinimise()}
          className="px-3 hover:bg-gray-700"
        >
          ─
        </button>
        <button
          onClick={() => WindowToggleMaximise()}
          className="px-3 hover:bg-gray-700"
        >
          □
        </button>
        <button
          onClick={() => Quit()}
          className="px-3 hover:bg-red-600"
        >
          ✕
        </button>
      </div>
    </div>
  )
}
```

Enable frameless in Go:
```go
// In wails.Run options:
Frameless: true,
```

## Menu Event Handling

```tsx
// Listen for menu events emitted from Go
function App() {
  useWailsEvent('menu-new', () => {
    // Handle File > New
    createNewFile()
  })

  useWailsEvent('menu-open', () => {
    // Handle File > Open
    openFile()
  })

  useWailsEvent('menu-save', () => {
    // Handle File > Save
    saveCurrentFile()
  })

  return <div>...</div>
}
```

## Drag & Drop Files

```tsx
function DropZone() {
  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    const files = Array.from(e.dataTransfer.files)

    for (const file of files) {
      // File.path is available in Wails (Electron-like)
      // But in Wails v2, use the Go side to handle file operations
      const content = await file.text()
      // Process content...
    }
  }, [])

  return (
    <div
      onDragOver={e => e.preventDefault()}
      onDrop={handleDrop}
      className="border-2 border-dashed border-gray-400 p-8 text-center"
    >
      Drop files here
    </div>
  )
}
```

## State Management Pattern

For Wails apps, keep it simple:

```tsx
// contexts/AppContext.tsx
import { createContext, useContext, useReducer, useEffect } from 'react'
import { GetSettings } from '@wailsjs/go/services/SettingsService'

type State = {
  theme: 'light' | 'dark' | 'system'
  currentFile: string | null
  modified: boolean
}

type Action =
  | { type: 'SET_THEME'; theme: State['theme'] }
  | { type: 'SET_FILE'; path: string; content: string }
  | { type: 'SET_MODIFIED'; modified: boolean }

const AppContext = createContext<{
  state: State
  dispatch: React.Dispatch<Action>
} | null>(null)

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'SET_THEME': return { ...state, theme: action.theme }
    case 'SET_FILE': return { ...state, currentFile: action.path, modified: false }
    case 'SET_MODIFIED': return { ...state, modified: action.modified }
    default: return state
  }
}

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reducer, {
    theme: 'system', currentFile: null, modified: false,
  })

  // Load settings from Go on mount
  useEffect(() => {
    GetSettings().then(settings => {
      dispatch({ type: 'SET_THEME', theme: settings.theme })
    })
  }, [])

  return (
    <AppContext.Provider value={{ state, dispatch }}>
      {children}
    </AppContext.Provider>
  )
}

export const useApp = () => useContext(AppContext)!
```

## Keyboard Shortcuts (Frontend)

```tsx
// hooks/useShortcut.ts
export function useShortcut(key: string, ctrl: boolean, handler: () => void) {
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      const mod = navigator.platform.includes('Mac') ? e.metaKey : e.ctrlKey
      if (mod === ctrl && e.key.toLowerCase() === key.toLowerCase()) {
        e.preventDefault()
        handler()
      }
    }
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [key, ctrl, handler])
}

// Usage:
useShortcut('s', true, () => saveFile())      // Ctrl/Cmd+S
useShortcut('n', true, () => newFile())        // Ctrl/Cmd+N
useShortcut('o', true, () => openFile())       // Ctrl/Cmd+O
```

## Environment Detection

```tsx
import { Environment } from '@wailsjs/runtime/runtime'

// Detect OS for platform-specific UI
const env = await Environment()
// env.buildType = "dev" | "production"
// env.platform = "windows" | "darwin" | "linux"
// env.arch = "amd64" | "arm64"
```

## Common Patterns

### Loading State for Go Calls

```tsx
function useGoCall<T>(fn: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const execute = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await fn()
      setData(result)
      return result
    } catch (err) {
      setError(String(err))
      return null
    } finally {
      setLoading(false)
    }
  }, [fn])

  return { data, loading, error, execute }
}

// Usage:
const { data: files, loading, execute: loadFiles } = useGoCall(ListFiles)
```

### Confirmation Before Close

```tsx
// In Go — handle OnBeforeClose
func (a *App) beforeClose(ctx context.Context) bool {
    if a.hasUnsavedChanges {
        result, _ := runtime.MessageDialog(ctx, runtime.MessageDialogOptions{
            Type:    runtime.QuestionDialog,
            Title:   "Unsaved Changes",
            Message: "You have unsaved changes. Close anyway?",
            Buttons: []string{"Close", "Cancel"},
        })
        return result == "Close" // true = allow close
    }
    return true
}

// In wails.Run options:
// OnBeforeClose: app.beforeClose,
```
