# Frontend Testing Patterns (Vitest / Jest + React Testing Library + MSW + Playwright)

## File layout

```
src/
  components/
    UserCard.tsx
    UserCard.test.tsx          # colocated unit
  hooks/
    useAuth.ts
    useAuth.test.ts
  pages/
    login.tsx
    login.test.tsx
test/
  setup.ts                     # vitest setup file
  mocks/
    handlers.ts                # MSW request handlers
    server.ts                  # MSW node server
  fixtures/
    user.ts
e2e/
  auth-flow.spec.ts            # Playwright
```

## Config

```ts
// vitest.config.ts
export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    globals: true,
    coverage: { reporter: ['text', 'html'], exclude: ['**/*.stories.*'] },
  },
})

// test/setup.ts
import '@testing-library/jest-dom/vitest'
import { server } from './mocks/server'
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())
```

## Testing Library — queries priority

Use queries in this order (by accessibility):

1. `getByRole('button', { name: /submit/i })` — closest to screen reader
2. `getByLabelText('Email')` — form fields
3. `getByPlaceholderText` — last resort for inputs
4. `getByText` — non-interactive content
5. `getByTestId` — escape hatch, only if nothing else fits

**Never** use `getByClassName` or query by DOM structure — coupling to implementation.

## user-event (not fireEvent)

```tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

it('submits form with typed values', async () => {
  const user = userEvent.setup()
  const onSubmit = vi.fn()
  render(<LoginForm onSubmit={onSubmit} />)

  await user.type(screen.getByLabelText(/email/i), 'a@b.com')
  await user.type(screen.getByLabelText(/password/i), 'secret')
  await user.click(screen.getByRole('button', { name: /log in/i }))

  expect(onSubmit).toHaveBeenCalledWith({ email: 'a@b.com', password: 'secret' })
})
```

## Async behavior — findBy, waitFor

```tsx
// After a fetch resolves
expect(await screen.findByText(/welcome/i)).toBeInTheDocument()

// For non-DOM assertions
await waitFor(() => expect(mockFn).toHaveBeenCalled())

// Wait for disappearance
await waitForElementToBeRemoved(() => screen.queryByText(/loading/i))
```

Prefer `findBy*` over `waitFor(() => getBy*)` — it's semantically clearer.

## MSW — mock API at network level

```ts
// test/mocks/handlers.ts
import { http, HttpResponse } from 'msw'

export const handlers = [
  http.post('/api/auth/login', async ({ request }) => {
    const { email, password } = await request.json() as any
    if (password === 'wrong') return new HttpResponse(null, { status: 401 })
    return HttpResponse.json({ token: 'jwt-abc' })
  }),
  http.get('/api/users/:id', ({ params }) =>
    HttpResponse.json({ id: params.id, email: 'u@test.com' })),
]

// test/mocks/server.ts
import { setupServer } from 'msw/node'
import { handlers } from './handlers'
export const server = setupServer(...handlers)
```

Per-test override:
```tsx
it('shows error on 500', async () => {
  server.use(http.get('/api/users/1', () => new HttpResponse(null, { status: 500 })))
  render(<UserProfile id="1" />)
  expect(await screen.findByText(/something went wrong/i)).toBeInTheDocument()
})
```

## Hooks — renderHook

```tsx
import { renderHook, act } from '@testing-library/react'

it('useCounter increments', () => {
  const { result } = renderHook(() => useCounter())
  act(() => result.current.increment())
  expect(result.current.count).toBe(1)
})

// With wrapper (providers)
const wrapper = ({ children }) => (
  <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
)
const { result } = renderHook(() => useUser('u1'), { wrapper })
```

## Context / providers — render helper

```tsx
// test/render.tsx
export function renderWithProviders(ui: React.ReactElement, opts?: { route?: string }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MemoryRouter initialEntries={[opts?.route ?? '/']}>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>{ui}</ThemeProvider>
      </QueryClientProvider>
    </MemoryRouter>
  )
}
```

## Form validation

```tsx
it('shows error for invalid email', async () => {
  const user = userEvent.setup()
  render(<LoginForm />)
  await user.type(screen.getByLabelText(/email/i), 'not-an-email')
  await user.tab()
  expect(await screen.findByText(/invalid email/i)).toBeInTheDocument()
})
```

## Accessibility in tests

```tsx
import { axe } from 'vitest-axe'
it('is accessible', async () => {
  const { container } = render(<LoginForm />)
  expect(await axe(container)).toHaveNoViolations()
})
```

## E2E — Playwright

```ts
// e2e/auth-flow.spec.ts
import { test, expect } from '@playwright/test'

test('full login flow', async ({ page }) => {
  await page.goto('/login')
  await page.getByLabel('Email').fill('a@b.com')
  await page.getByLabel('Password').fill('secret')
  await page.getByRole('button', { name: /log in/i }).click()
  await expect(page).toHaveURL(/\/dashboard/)
  await expect(page.getByText(/welcome/i)).toBeVisible()
})
```

Use `locator`-first API + `expect(locator).toBeVisible()` (auto-retries). Avoid `waitForTimeout`.

## Snapshot testing — use sparingly

Only for stable, visual components. Inline snapshots for readability:

```tsx
expect(screen.getByRole('dialog')).toMatchInlineSnapshot(`...`)
```

Skip for dynamic content (timestamps, ids) — maintenance burden outweighs value.

## What NOT to test

- Library behavior (React, react-query, router) — trust upstream
- CSS / visual styling — use visual regression (Chromatic / Percy) or snapshot tests
- Implementation details (state hooks, internal methods) — test user-visible behavior
- Third-party components you don't control — test your wrapper's API

## Coverage priorities

1. **Forms + business logic**: validation, submission, error states → 85%+
2. **Critical user flows**: auth, checkout, data mutation → E2E + integration
3. **Custom hooks** with logic → renderHook coverage
4. **UI components**: happy render + 1-2 interaction states; don't chase 100%
5. **Pages / routing** — smoke E2E is enough

## Common pitfalls

- Using `fireEvent` instead of `user-event` → skips focus / composition events
- Querying by class / testId when role exists → tighter coupling
- Forgetting `await` on user-event — silent flakes
- Not resetting MSW handlers between tests
- `act()` warnings → wrap state updates or use `findBy*`
- Testing `useEffect` side effects via spy instead of observable outcome
- React 18 `<StrictMode>` double-renders — handle in setup or disable in tests
