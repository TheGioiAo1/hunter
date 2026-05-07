/**
 * Tests for the error page templates (Phase 2 Step 2.11).
 */

import { describe, it, expect } from 'vitest'
import {
  errorPage,
  notFoundPage,
  forbiddenPage,
  serverErrorPage,
  unauthorizedPage,
  serviceUnavailablePage,
  errorPageCss,
} from './error-page.js'

// ---------------------------------------------------------------------------
// errorPage
// ---------------------------------------------------------------------------

describe('errorPage', () => {
  it('renders the code, title, and detail', () => {
    const html = errorPage({
      code: 418,
      title: "I'm a teapot",
      detail: 'Short and stout.',
    })
    expect(html).toContain('>418<')
    expect(html).toContain('I&#39;m a teapot')
    expect(html).toContain('Short and stout.')
  })

  it('marks the container as an alert region', () => {
    expect(errorPage({ code: 404, title: 'Nope' })).toContain('role="alert"')
  })

  it('links the heading via aria-labelledby', () => {
    const html = errorPage({ code: 404, title: 'Nope' })
    expect(html).toContain('aria-labelledby="gbox-err-title"')
    expect(html).toContain('id="gbox-err-title"')
  })

  it('renders primary + secondary action buttons', () => {
    const html = errorPage({
      code: 500,
      title: 'Crash',
      actions: [
        { label: 'Retry', href: '#', kind: 'primary' },
        { label: 'Home', href: '/', kind: 'secondary' },
      ],
    })
    expect(html).toContain('Retry')
    expect(html).toContain('gbox-err-btn-primary')
    expect(html).toContain('Home')
    expect(html).toContain('gbox-err-btn-secondary')
  })

  it('defaults missing kind to primary', () => {
    const html = errorPage({
      code: 500,
      title: 'x',
      actions: [{ label: 'Go', href: '/' }],
    })
    expect(html).toContain('gbox-err-btn-primary')
  })

  it('renders the request id when provided', () => {
    const html = errorPage({
      code: 500,
      title: 'x',
      requestId: 'req_abc123',
    })
    expect(html).toContain('req_abc123')
    expect(html).toContain('Request id')
  })

  it('renders the support line when supportHref is set', () => {
    const html = errorPage({
      code: 500,
      title: 'x',
      supportHref: 'mailto:help@gbox.co',
      supportLabel: 'Contact support',
    })
    expect(html).toContain('mailto:help@gbox.co')
    expect(html).toContain('Contact support')
  })

  it('escapes the title, detail, request id, and button labels', () => {
    const html = errorPage({
      code: 500,
      title: '<script>bad</script>',
      detail: '<img src=x>',
      requestId: '"><script>',
      actions: [{ label: '<evil>', href: '/' }],
    })
    expect(html).not.toContain('<script>bad</script>')
    expect(html).not.toContain('<img src=x>')
    expect(html).not.toContain('<evil>')
    expect(html).toContain('&lt;script&gt;bad')
    expect(html).toContain('&lt;img')
  })

  it('honors custom iconSvg override', () => {
    const html = errorPage({
      code: 404,
      title: 'x',
      iconSvg: '<svg data-custom="1"></svg>',
    })
    expect(html).toContain('data-custom="1"')
  })
})

// ---------------------------------------------------------------------------
// Convenience shortcuts
// ---------------------------------------------------------------------------

describe('notFoundPage', () => {
  it('renders a 404 with default copy when given god-admin href', () => {
    const html = notFoundPage('/god-admin')
    expect(html).toContain('>404<')
    expect(html).toContain('Page not found')
    expect(html).toContain('Back to dashboard')
    expect(html).toContain('href="/god-admin"')
  })

  it('allows overrides', () => {
    const html = notFoundPage('/god-admin', { title: 'Gone', detail: 'Moved.' })
    expect(html).toContain('Gone')
    expect(html).toContain('Moved.')
  })

  // Iron Rule 5 (CLAUDE.md): passing a seller-facing dashboard path must
  // NOT cause a `/god-admin` path to leak anywhere in the output. This
  // locks in that the required-arg refactor removed the old default.
  it('never emits /god-admin when caller passes a seller path', () => {
    const html = notFoundPage('/admin')
    expect(html).toContain('href="/admin"')
    expect(html).not.toMatch(/\/god-admin/i)
  })
})

describe('forbiddenPage', () => {
  it('renders a 403', () => {
    const html = forbiddenPage('/god-admin')
    expect(html).toContain('>403<')
    expect(html).toContain('You don&#39;t have access')
    expect(html).toContain('href="/god-admin"')
  })

  it('never emits /god-admin when caller passes a seller path', () => {
    const html = forbiddenPage('/admin')
    expect(html).toContain('href="/admin"')
    expect(html).not.toMatch(/\/god-admin/i)
  })
})

describe('serverErrorPage', () => {
  it('renders a 500 with two actions', () => {
    const html = serverErrorPage('/god-admin')
    expect(html).toContain('>500<')
    expect(html).toContain('Something went wrong')
    expect(html).toContain('Try again')
    expect(html).toContain('Back to dashboard')
    expect(html).toContain('href="/god-admin"')
  })

  it('never emits /god-admin when caller passes a seller path', () => {
    const html = serverErrorPage('/admin')
    expect(html).toContain('href="/admin"')
    expect(html).not.toMatch(/\/god-admin/i)
  })
})

describe('unauthorizedPage', () => {
  it('renders a 401 with sign-in link', () => {
    const html = unauthorizedPage()
    expect(html).toContain('>401<')
    expect(html).toContain('Sign in')
  })
})

describe('serviceUnavailablePage', () => {
  it('renders a 503', () => {
    const html = serviceUnavailablePage()
    expect(html).toContain('>503<')
    expect(html).toContain('Service unavailable')
  })
})

// ---------------------------------------------------------------------------
// Default icon selection
// ---------------------------------------------------------------------------

describe('default icons', () => {
  it('uses the gear icon for 5xx', () => {
    const html = errorPage({ code: 500, title: 'x' })
    // Gear path fragment.
    expect(html).toContain('M19.4 15')
  })

  it('uses the lock icon for 401/403', () => {
    const html403 = errorPage({ code: 403, title: 'x' })
    const html401 = errorPage({ code: 401, title: 'x' })
    expect(html403).toContain('<rect x="3" y="11"')
    expect(html401).toContain('<rect x="3" y="11"')
  })

  it('uses the compass icon for 404', () => {
    const html = errorPage({ code: 404, title: 'x' })
    expect(html).toContain('<circle cx="12" cy="12" r="10"')
  })
})

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

describe('errorPageCss', () => {
  it('defines the core classes', () => {
    const css = errorPageCss()
    expect(css).toContain('.gbox-err')
    expect(css).toContain('.gbox-err-code')
    expect(css).toContain('.gbox-err-title')
    expect(css).toContain('.gbox-err-btn-primary')
    expect(css).toContain('.gbox-err-btn-secondary')
  })
})
