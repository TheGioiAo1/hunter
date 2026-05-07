/**
 * Unit tests for brand-kit-extractor.ts
 *
 * Tests the pure HTML parsing helpers (inline styles + CSS link
 * extraction). The full extractAndPersistBrandKit function requires
 * safeFetch + DB, so it's integration-tested on the server.
 */

import { describe, it, expect } from 'vitest';
import { extractInlineStyles, extractCssLinks } from './brand-kit-extractor.js';

describe('extractInlineStyles', () => {
  it('extracts single <style> block', () => {
    const html = '<html><head><style>body { color: red; }</style></head></html>';
    expect(extractInlineStyles(html)).toBe('body { color: red; }');
  });

  it('extracts multiple <style> blocks', () => {
    const html =
      '<style>a { color: blue; }</style>' +
      '<div>hello</div>' +
      '<style type="text/css">.x { margin: 0; }</style>';
    const result = extractInlineStyles(html);
    expect(result).toContain('a { color: blue; }');
    expect(result).toContain('.x { margin: 0; }');
  });

  it('returns empty string when no <style> blocks', () => {
    expect(extractInlineStyles('<html><body></body></html>')).toBe('');
  });

  it('handles multiline <style> blocks', () => {
    const html = `<style>
      body {
        font-family: 'Inter';
        background: #fff;
      }
    </style>`;
    const result = extractInlineStyles(html);
    expect(result).toContain("font-family: 'Inter'");
    expect(result).toContain('background: #fff');
  });
});

describe('extractCssLinks', () => {
  it('extracts absolute href from <link rel="stylesheet">', () => {
    const html =
      '<link rel="stylesheet" href="https://cdn.example.com/style.css">';
    const links = extractCssLinks(html, 'https://example.com');
    expect(links).toEqual(['https://cdn.example.com/style.css']);
  });

  it('resolves relative href against base URL', () => {
    const html = '<link rel="stylesheet" href="/assets/theme.css">';
    const links = extractCssLinks(html, 'https://example.com/products/foo');
    expect(links).toEqual(['https://example.com/assets/theme.css']);
  });

  it('extracts multiple stylesheet links', () => {
    const html =
      '<link rel="stylesheet" href="/a.css">' +
      '<link rel="stylesheet" href="/b.css">' +
      '<link rel="icon" href="/favicon.ico">';
    const links = extractCssLinks(html, 'https://x.com');
    expect(links).toHaveLength(2);
    expect(links[0]).toContain('/a.css');
    expect(links[1]).toContain('/b.css');
  });

  it('ignores non-stylesheet links', () => {
    const html = '<link rel="preload" href="/font.woff2" as="font">';
    const links = extractCssLinks(html, 'https://x.com');
    expect(links).toHaveLength(0);
  });

  it('handles single-quoted attributes', () => {
    const html = "<link rel='stylesheet' href='/style.css'>";
    const links = extractCssLinks(html, 'https://x.com');
    expect(links).toHaveLength(1);
  });

  it('returns empty array for no links', () => {
    expect(extractCssLinks('<html></html>', 'https://x.com')).toEqual([]);
  });
});
