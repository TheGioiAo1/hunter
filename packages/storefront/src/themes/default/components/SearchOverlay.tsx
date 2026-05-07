/**
 * SearchOverlay — React island for live search with debounced input.
 *
 * Fetches results from /api/2026-04/search.json and displays a
 * dropdown with product results. Closes on Escape key.
 */

import { useState, useEffect, useRef, useCallback } from 'react';

interface SearchResultItem {
  id: string;
  title: string;
  slug: string;
  price: string;
  image: string | null;
  relevance: number;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

function formatPrice(amount: string, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
  }).format(parseFloat(amount));
}

export default function SearchOverlay({ isOpen, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResultItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  // Focus input when overlay opens
  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus();
    }
    if (!isOpen) {
      setQuery('');
      setResults([]);
      setTotal(0);
    }
  }, [isOpen]);

  // Close on Escape key
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onClose();
      }
    }

    if (isOpen) {
      document.addEventListener('keydown', handleKeyDown);
      return () => document.removeEventListener('keydown', handleKeyDown);
    }
  }, [isOpen, onClose]);

  // Debounced search
  const performSearch = useCallback(async (searchQuery: string) => {
    if (!searchQuery.trim()) {
      setResults([]);
      setTotal(0);
      setLoading(false);
      return;
    }

    setLoading(true);

    try {
      const params = new URLSearchParams({
        q: searchQuery,
        type: 'product',
        limit: '6',
      });

      const res = await fetch(`/api/2026-04/search.json?${params.toString()}`);

      if (!res.ok) {
        throw new Error('Search failed');
      }

      const data = await res.json();
      setResults(data.results ?? []);
      setTotal(data.total ?? 0);
    } catch {
      setResults([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value;
      setQuery(value);

      // Clear previous debounce
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }

      // Debounce 300ms
      debounceRef.current = setTimeout(() => {
        performSearch(value);
      }, 300);
    },
    [performSearch],
  );

  if (!isOpen) return null;

  return (
    <div className="search-overlay" role="dialog" aria-label="Search" aria-modal="true">
      <div className="search-overlay__backdrop" onClick={onClose} />

      <div className="search-overlay__panel">
        {/* Search input */}
        <div className="search-overlay__input-wrap">
          <svg
            className="search-overlay__icon"
            viewBox="0 0 24 24"
            width="20"
            height="20"
            aria-hidden="true"
          >
            <circle
              cx="11"
              cy="11"
              r="7"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            />
            <line
              x1="16.5"
              y1="16.5"
              x2="21"
              y2="21"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>

          <input
            ref={inputRef}
            type="search"
            placeholder="Search products..."
            value={query}
            onChange={handleInputChange}
            aria-label="Search products"
            className="search-overlay__input"
          />

          <button
            type="button"
            className="search-overlay__close"
            onClick={onClose}
            aria-label="Close search"
          >
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
              <line
                x1="18"
                y1="6"
                x2="6"
                y2="18"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
              <line
                x1="6"
                y1="6"
                x2="18"
                y2="18"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        {/* Results dropdown */}
        {query.trim() && (
          <div className="search-overlay__results">
            {loading ? (
              <div className="search-overlay__loading">
                <span className="loading-spinner" />
                Searching...
              </div>
            ) : results.length > 0 ? (
              <>
                <ul className="search-overlay__list">
                  {results.map((item) => (
                    <li key={item.id}>
                      <a
                        href={`/products/${item.slug}`}
                        className="search-overlay__result"
                        onClick={onClose}
                      >
                        <div className="search-overlay__result-image">
                          {item.image ? (
                            <img
                              src={item.image}
                              alt={item.title}
                              width="48"
                              height="48"
                              loading="lazy"
                            />
                          ) : (
                            <div className="search-overlay__result-placeholder" />
                          )}
                        </div>
                        <div className="search-overlay__result-info">
                          <span className="search-overlay__result-title">
                            {item.title}
                          </span>
                          <span className="search-overlay__result-price">
                            {formatPrice(item.price)}
                          </span>
                        </div>
                      </a>
                    </li>
                  ))}
                </ul>

                {total > results.length && (
                  <a
                    href={`/search?q=${encodeURIComponent(query)}`}
                    className="search-overlay__view-all"
                    onClick={onClose}
                  >
                    View all {total} results
                  </a>
                )}
              </>
            ) : (
              <div className="search-overlay__empty">
                No results found for &ldquo;{query}&rdquo;
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
