# Wails Go Bindings

## App Lifecycle

```go
// main.go
package main

import (
    "embed"
    "myapp/internal/services"

    "github.com/wailsapp/wails/v2"
    "github.com/wailsapp/wails/v2/pkg/options"
    "github.com/wailsapp/wails/v2/pkg/options/assetserver"
    "github.com/wailsapp/wails/v2/pkg/options/windows"
    "github.com/wailsapp/wails/v2/pkg/options/mac"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
    app := NewApp()
    fileSvc := services.NewFileService()
    settingsSvc := services.NewSettingsService()

    err := wails.Run(&options.App{
        Title:     "My App",
        Width:     1024,
        Height:    768,
        MinWidth:  800,
        MinHeight: 600,

        AssetServer: &assetserver.Options{
            Assets: assets,
        },

        // Lifecycle hooks
        OnStartup:  app.startup,
        OnDomReady: app.domReady,
        OnShutdown: app.shutdown,

        // Bind Go structs to frontend
        Bind: []interface{}{
            app,
            fileSvc,
            settingsSvc,
        },

        // Platform-specific
        Windows: &windows.Options{
            WebviewIsTransparent: false,
            WindowIsTranslucent:  false,
        },
        Mac: &mac.Options{
            TitleBar: mac.TitleBarHiddenInset(),
            About: &mac.AboutInfo{
                Title:   "My App",
                Message: "A desktop application",
            },
        },
    })

    if err != nil {
        println("Error:", err.Error())
    }
}
```

## App Struct & Lifecycle Hooks

```go
// app.go
package main

import (
    "context"
    "github.com/wailsapp/wails/v2/pkg/runtime"
)

type App struct {
    ctx context.Context
}

func NewApp() *App {
    return &App{}
}

// startup is called when the app starts. Save context for runtime calls.
func (a *App) startup(ctx context.Context) {
    a.ctx = ctx
    // Initialize resources, DB connections, etc.
}

// domReady is called after frontend DOM is ready
func (a *App) domReady(ctx context.Context) {
    // Emit initial data to frontend
    runtime.EventsEmit(ctx, "app-ready", map[string]any{
        "version": "1.0.0",
    })
}

// shutdown is called when the app is closing
func (a *App) shutdown(ctx context.Context) {
    // Cleanup: close DB, save state, etc.
}
```

## Service Binding Pattern

```go
// internal/services/file_service.go
package services

import (
    "context"
    "fmt"
    "os"

    "github.com/wailsapp/wails/v2/pkg/runtime"
)

type FileService struct {
    ctx context.Context
}

func NewFileService() *FileService {
    return &FileService{}
}

// OnStartup stores context — called by app.startup or via Wails lifecycle
func (f *FileService) SetContext(ctx context.Context) {
    f.ctx = ctx
}

// OpenFile shows native file dialog and returns file content
// Frontend calls: FileService.OpenFile()
func (f *FileService) OpenFile() (*FileResult, error) {
    path, err := runtime.OpenFileDialog(f.ctx, runtime.OpenDialogOptions{
        Title: "Open File",
        Filters: []runtime.FileFilter{
            {DisplayName: "Text Files", Pattern: "*.txt;*.md;*.json"},
            {DisplayName: "All Files", Pattern: "*.*"},
        },
    })
    if err != nil {
        return nil, fmt.Errorf("dialog error: %w", err)
    }
    if path == "" {
        return nil, nil // User cancelled
    }

    content, err := os.ReadFile(path)
    if err != nil {
        return nil, fmt.Errorf("read file: %w", err)
    }

    return &FileResult{
        Path:    path,
        Content: string(content),
    }, nil
}

// SaveFile saves content to a file
func (f *FileService) SaveFile(path, content string) error {
    return os.WriteFile(path, []byte(content), 0644)
}

// SaveFileDialog shows save dialog, returns chosen path
func (f *FileService) SaveFileDialog(defaultFilename string) (string, error) {
    return runtime.SaveFileDialog(f.ctx, runtime.SaveDialogOptions{
        Title:           "Save File",
        DefaultFilename: defaultFilename,
    })
}
```

## Data Models (Auto-generates TypeScript)

```go
// internal/models/file.go
package models

type FileResult struct {
    Path    string `json:"path"`
    Content string `json:"content"`
}

type AppSettings struct {
    Theme       string `json:"theme"`       // "light" | "dark" | "system"
    FontSize    int    `json:"fontSize"`
    AutoSave    bool   `json:"autoSave"`
    RecentFiles []string `json:"recentFiles"`
}

// Nested structs work too — generates nested TS interfaces
type Project struct {
    ID       string   `json:"id"`
    Name     string   `json:"name"`
    Files    []File   `json:"files"`
    Settings Settings `json:"settings"`
}

type File struct {
    Path     string `json:"path"`
    Modified bool   `json:"modified"`
}

type Settings struct {
    Indent   int  `json:"indent"`
    WordWrap bool `json:"wordWrap"`
}
```

## Go → TypeScript Type Mapping

| Go Type | TypeScript Type |
|---------|----------------|
| `string` | `string` |
| `int`, `int64`, `float64` | `number` |
| `bool` | `boolean` |
| `[]T` | `T[]` |
| `map[string]T` | `{ [key: string]: T }` |
| `*T` (pointer) | `T \| null` |
| `error` (return) | Rejects the Promise |
| `struct` | `interface` (auto-generated) |

## Error Handling

```go
// Errors returned from bound methods reject the Promise on frontend
func (s *Service) RiskyOperation() (string, error) {
    result, err := doSomething()
    if err != nil {
        // This becomes a rejected Promise in JS
        return "", fmt.Errorf("operation failed: %w", err)
    }
    return result, nil
}

// Frontend catches it:
// try { await RiskyOperation() } catch (err) { console.error(err) }
```

## Events (Go → Frontend)

```go
// Emit event to frontend
runtime.EventsEmit(a.ctx, "file-changed", FileResult{
    Path: "/path/to/file",
    Content: "new content",
})

// Emit simple notification
runtime.EventsEmit(a.ctx, "status-update", "Processing complete")

// Emit with multiple data args
runtime.EventsEmit(a.ctx, "download-progress", map[string]any{
    "percent":  75,
    "filename": "data.csv",
})
```

## Window Control from Go

```go
// Window operations
runtime.WindowSetTitle(a.ctx, "My App - document.txt")
runtime.WindowSetSize(a.ctx, 1200, 800)
runtime.WindowSetMinSize(a.ctx, 640, 480)
runtime.WindowSetMaxSize(a.ctx, 1920, 1080)
runtime.WindowCenter(a.ctx)
runtime.WindowMaximise(a.ctx)
runtime.WindowMinimise(a.ctx)
runtime.WindowToggleMaximise(a.ctx)
runtime.WindowFullscreen(a.ctx)
runtime.WindowUnfullscreen(a.ctx)
runtime.WindowShow(a.ctx)
runtime.WindowHide(a.ctx)

// Frameless window drag
// Use wails-drag attribute in HTML: <div data-wails-drag>Title Bar</div>
```

## Native Dialogs from Go

```go
// Message dialog
result, _ := runtime.MessageDialog(a.ctx, runtime.MessageDialogOptions{
    Type:          runtime.QuestionDialog,
    Title:         "Confirm",
    Message:       "Save changes before closing?",
    Buttons:       []string{"Save", "Discard", "Cancel"},
    DefaultButton: "Save",
    CancelButton:  "Cancel",
})
// result = "Save" | "Discard" | "Cancel"

// Directory dialog
dir, _ := runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{
    Title: "Select Project Folder",
})

// Multiple files
files, _ := runtime.OpenMultipleFilesDialog(a.ctx, runtime.OpenDialogOptions{
    Title: "Select Files",
    Filters: []runtime.FileFilter{
        {DisplayName: "Images", Pattern: "*.png;*.jpg;*.gif"},
    },
})
```

## Local Database (SQLite + GORM)

```go
// internal/database/database.go
import (
    "gorm.io/driver/sqlite"
    "gorm.io/gorm"
)

func Connect(dbPath string) (*gorm.DB, error) {
    db, err := gorm.Open(sqlite.Open(dbPath), &gorm.Config{})
    if err != nil {
        return nil, err
    }
    db.AutoMigrate(&Project{}, &File{}, &Settings{})
    return db, nil
}

// Use in App startup:
func (a *App) startup(ctx context.Context) {
    a.ctx = ctx
    configDir, _ := os.UserConfigDir()
    dbPath := filepath.Join(configDir, "myapp", "data.db")
    os.MkdirAll(filepath.Dir(dbPath), 0755)
    a.db, _ = database.Connect(dbPath)
}
```

## Menus

```go
import "github.com/wailsapp/wails/v2/pkg/menu"
import "github.com/wailsapp/wails/v2/pkg/menu/keys"

func (a *App) createMenu() *menu.Menu {
    appMenu := menu.NewMenu()

    fileMenu := appMenu.AddSubmenu("File")
    fileMenu.AddText("New", keys.CmdOrCtrl("n"), func(_ *menu.CallbackData) {
        runtime.EventsEmit(a.ctx, "menu-new")
    })
    fileMenu.AddText("Open", keys.CmdOrCtrl("o"), func(_ *menu.CallbackData) {
        runtime.EventsEmit(a.ctx, "menu-open")
    })
    fileMenu.AddSeparator()
    fileMenu.AddText("Save", keys.CmdOrCtrl("s"), func(_ *menu.CallbackData) {
        runtime.EventsEmit(a.ctx, "menu-save")
    })
    fileMenu.AddSeparator()
    fileMenu.AddText("Quit", keys.CmdOrCtrl("q"), func(_ *menu.CallbackData) {
        runtime.Quit(a.ctx)
    })

    return appMenu
}

// Pass to wails.Run options:
// Menu: app.createMenu(),
```
