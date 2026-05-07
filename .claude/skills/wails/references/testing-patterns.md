# Wails Testing Patterns (Go side + React frontend + E2E)

Wails is a dual-runtime desktop app framework: Go backend bound to a React/Svelte frontend via auto-generated bindings. Testing has **three layers**: Go unit tests, frontend component tests, and full-app E2E.

## File layout

```
app/
  app.go                   # exposes methods to frontend
  app_test.go              # Go unit tests
  services/
    user_service.go
    user_service_test.go
frontend/
  src/
    components/
      LoginForm.tsx
      LoginForm.test.tsx   # Vitest + RTL
    wailsjs/               # auto-generated bindings (DO NOT test)
  vitest.config.ts
test/
  e2e/
    login.spec.ts          # Playwright driving the packaged app
  mocks/
    wails-bindings.ts      # fake generated bindings for frontend tests
```

## Layer 1 — Go side (standard Go testing)

Wails `app.go` exposes methods that the frontend calls. Test these like any Go method. See `go-backend/references/testing-patterns.md` for the full Go playbook — table-driven, testify, httptest.

```go
// app/app_test.go
func TestApp_SaveFile(t *testing.T) {
    tmp := t.TempDir()
    app := &App{storageDir: tmp}

    err := app.SaveFile("notes.md", []byte("hello"))
    require.NoError(t, err)

    content, _ := os.ReadFile(filepath.Join(tmp, "notes.md"))
    assert.Equal(t, "hello", string(content))
}
```

**Exposed methods should be pure + stateless when possible.** Side effects (filesystem, dialogs, window state) → inject dependencies so tests can fake them:

```go
type App struct {
    dialog   DialogService    // interface — fake in tests
    storage  StorageService
}

type mockDialog struct {
    openResult string
    openErr    error
}
func (m *mockDialog) Open(opts OpenOpts) (string, error) {
    return m.openResult, m.openErr
}
```

## Layer 2 — Frontend (mock wailsjs bindings)

Problem: `frontend/wailsjs/` is auto-generated at build time. In unit tests (no Wails runtime), imports break.

**Solution: alias in vitest.config.ts**:

```ts
// vitest.config.ts
export default defineConfig({
  resolve: {
    alias: {
      '../../wailsjs/go/main/App': path.resolve(__dirname, 'test/mocks/wails-bindings.ts'),
    },
  },
  test: { environment: 'jsdom', globals: true },
})
```

```ts
// test/mocks/wails-bindings.ts
import { vi } from 'vitest'

export const SaveFile = vi.fn<[string, number[]], Promise<void>>()
export const OpenFileDialog = vi.fn<[], Promise<string>>()
// ... one export per exposed Go method
```

Reset between tests:
```ts
beforeEach(() => {
  vi.mocked(SaveFile).mockReset()
  vi.mocked(OpenFileDialog).mockReset()
})
```

## Layer 2 — Component example

```tsx
import { SaveFile } from '../../wailsjs/go/main/App'
import { vi } from 'vitest'

vi.mock('../../wailsjs/go/main/App')  // use mock file alias

it('save button calls Go SaveFile', async () => {
  vi.mocked(SaveFile).mockResolvedValue()
  const user = userEvent.setup()
  render(<NoteEditor initialText="hello" />)

  await user.click(screen.getByRole('button', { name: /save/i }))

  expect(SaveFile).toHaveBeenCalledWith('notes.md', expect.any(Array))
})

it('shows error toast when Go call fails', async () => {
  vi.mocked(SaveFile).mockRejectedValue(new Error('disk full'))
  const user = userEvent.setup()
  render(<NoteEditor initialText="x" />)
  await user.click(screen.getByRole('button', { name: /save/i }))
  expect(await screen.findByText(/disk full/i)).toBeInTheDocument()
})
```

## Layer 2 — Event system testing

Wails has an event bus (`EventsOn`, `EventsEmit`). Mock runtime module:

```ts
// test/mocks/wails-runtime.ts
const listeners = new Map<string, ((...args: any[]) => void)[]>()

export const EventsOn = vi.fn((name: string, cb: (...args: any[]) => void) => {
  const arr = listeners.get(name) ?? []
  arr.push(cb)
  listeners.set(name, arr)
  return () => listeners.set(name, arr.filter(c => c !== cb))
})

export const EventsEmit = vi.fn((name: string, ...args: any[]) => {
  listeners.get(name)?.forEach(cb => cb(...args))
})

export function __resetEventMocks() {
  listeners.clear()
  vi.mocked(EventsOn).mockClear()
  vi.mocked(EventsEmit).mockClear()
}
```

Then test both directions (Go → UI and UI → Go) without a real runtime.

## Layer 3 — E2E with Playwright on the packaged app

Wails apps run in a native webview (WebView2 on Windows, WKWebView on macOS). For true E2E, use Playwright's Chromium driver against a **dev-mode Wails app** (it runs in Chromium):

```ts
// playwright.config.ts
export default defineConfig({
  webServer: {
    command: 'wails dev -noreload',
    url: 'http://localhost:34115',   // default wails dev port
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
  use: { baseURL: 'http://localhost:34115' },
})
```

```ts
// e2e/login.spec.ts
test('login flow', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('Email').fill('a@b.com')
  await page.getByLabel('Password').fill('secret')
  await page.getByRole('button', { name: /log in/i }).click()
  await expect(page.getByText(/welcome/i)).toBeVisible()
})
```

For production-build E2E (real WebView2 / WKWebView), use platform-specific drivers — out of scope for most projects. Dev-mode E2E covers 95% of regressions.

## Filesystem & dialog testing (Layer 1)

```go
// Never hardcode dialog/file paths in app methods.
// Instead, inject a DialogService interface and a filesystem root.
func TestApp_ImportCSV_CancelledDialog(t *testing.T) {
    app := &App{
        dialog: &mockDialog{openResult: ""},   // user cancelled
    }
    result, err := app.ImportCSV()
    assert.Empty(t, result)
    assert.NoError(t, err)  // cancellation is not an error
}
```

## Window / runtime calls (Layer 1)

Wails runtime calls (`runtime.WindowSetTitle`, `runtime.MessageDialog`) require a live app context. In tests, guard with an interface:

```go
type Runtime interface {
    WindowSetTitle(ctx context.Context, title string)
    MessageDialog(ctx context.Context, opts runtime.MessageDialogOptions) (string, error)
}

// prod: wails runtime wrapper
// test: noop / recording mock
```

## Coverage priorities

1. **Go app methods** (business logic in `app.go` and services) → 80%+ statements
2. **Frontend state / data handling** (hooks, stores) → 80%+
3. **Component user flows** → happy + 2-3 errors; don't chase 100%
4. **Auto-generated wailsjs bindings** → NEVER test — they're build artifacts
5. **Main.go / wire-up** → smoke build only
6. **Packaging / installer behavior** → manual smoke on each platform per release

## Common pitfalls

- Importing real `../../wailsjs/go/...` in unit tests → breaks outside `wails dev`. Always alias in test config.
- Testing Go methods that depend on `context.Context` from Wails runtime → use `context.Background()` + inject runtime interface
- Forgetting to reset event bus mocks → cross-test pollution
- Flaky E2E from race between `wails dev` startup and Playwright → increase `webServer.timeout`
- Platform-specific code (`runtime.GOOS`) not covered on CI → build matrix or `//go:build darwin` tags
- Mocking generated bindings inside-out each test → centralize in `test/mocks/wails-bindings.ts`
- Using `t.Parallel()` on tests that touch the same TempDir → separate with per-test `t.TempDir()`
