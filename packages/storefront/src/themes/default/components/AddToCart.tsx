/**
 * AddToCart — React island for interactive product purchasing.
 *
 * Handles variant selection, quantity adjustment, and add-to-cart submission
 * with loading states and success feedback.
 */

import { useState, useCallback } from 'react';

interface Variant {
  id: string;
  title: string;
  price: string;
  compare_at_price: string | null;
  option1: string | null;
  option2: string | null;
  option3: string | null;
  available: boolean;
  inventory_quantity: number;
}

interface ProductOption {
  name: string;
  values: string[];
}

interface Props {
  variants: Variant[];
  options: ProductOption[];
  shopId: string;
  productTitle: string;
}

function formatPrice(amount: string, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
  }).format(parseFloat(amount));
}

export default function AddToCart({ variants, options, shopId, productTitle }: Props) {
  const hasMultipleVariants = variants.length > 1;

  const [selectedVariantId, setSelectedVariantId] = useState(variants[0]?.id ?? '');
  const [selectedOptions, setSelectedOptions] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    if (variants[0]) {
      options.forEach((opt, i) => {
        const key = `option${i + 1}` as 'option1' | 'option2' | 'option3';
        initial[opt.name] = variants[0][key] ?? '';
      });
    }
    return initial;
  });
  const [quantity, setQuantity] = useState(1);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState('');

  const selectedVariant = variants.find((v) => v.id === selectedVariantId) ?? variants[0];
  const isAvailable = selectedVariant?.available ?? false;

  const handleOptionChange = useCallback(
    (optionName: string, value: string) => {
      const newOptions = { ...selectedOptions, [optionName]: value };
      setSelectedOptions(newOptions);

      // Find matching variant
      const match = variants.find((v) => {
        return options.every((opt, i) => {
          const key = `option${i + 1}` as 'option1' | 'option2' | 'option3';
          return v[key] === newOptions[opt.name];
        });
      });

      if (match) {
        setSelectedVariantId(match.id);
      }
    },
    [selectedOptions, variants, options],
  );

  const handleQuantityChange = useCallback((delta: number) => {
    setQuantity((prev) => Math.max(1, prev + delta));
  }, []);

  const handleAddToCart = useCallback(async () => {
    if (!selectedVariant || !isAvailable) return;

    setLoading(true);
    setError('');
    setSuccess(false);

    try {
      // Get cart token from cookie
      const cartToken = document.cookie
        .split('; ')
        .find((c) => c.startsWith('cart_token='))
        ?.split('=')[1];

      const res = await fetch('/api/cart/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shop_id: shopId,
          variant_id: selectedVariant.id,
          quantity,
          cart_token: cartToken,
        }),
      });

      if (!res.ok) {
        throw new Error('Failed to add item to cart');
      }

      const data = await res.json();

      // Store cart token
      if (data.cart?.token) {
        document.cookie = `cart_token=${data.cart.token};path=/;max-age=${60 * 60 * 24 * 30};SameSite=Lax`;
      }

      // Update cart count in header
      const cartCountEl = document.querySelector('.cart-count');
      if (cartCountEl && data.cart?.item_count !== undefined) {
        cartCountEl.textContent = String(data.cart.item_count);
        cartCountEl.style.display = 'flex';
      }

      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }, [selectedVariant, isAvailable, shopId, quantity]);

  return (
    <div className="add-to-cart">
      {/* Variant selectors */}
      {hasMultipleVariants &&
        options.map((option) => (
          <div key={option.name} className="variant-selector">
            <label className="variant-selector__label">{option.name}</label>
            <select
              className="form-select"
              value={selectedOptions[option.name] ?? ''}
              onChange={(e) => handleOptionChange(option.name, e.target.value)}
            >
              {option.values.map((val) => (
                <option key={val} value={val}>
                  {val}
                </option>
              ))}
            </select>
          </div>
        ))}

      {/* Quantity selector */}
      <div className="quantity-selector">
        <button
          type="button"
          onClick={() => handleQuantityChange(-1)}
          aria-label="Decrease quantity"
          disabled={quantity <= 1}
        >
          &minus;
        </button>
        <input
          type="number"
          value={quantity}
          min={1}
          onChange={(e) => setQuantity(Math.max(1, parseInt(e.target.value) || 1))}
          aria-label="Quantity"
        />
        <button
          type="button"
          onClick={() => handleQuantityChange(1)}
          aria-label="Increase quantity"
        >
          +
        </button>
      </div>

      {/* Add to Cart button */}
      <button
        type="button"
        className="btn btn--primary btn--full"
        onClick={handleAddToCart}
        disabled={loading || !isAvailable}
        aria-busy={loading}
      >
        {loading ? (
          <span className="flex items-center justify-center gap-2">
            <span className="loading-spinner" />
            Adding...
          </span>
        ) : !isAvailable ? (
          'Sold Out'
        ) : (
          `Add to Cart${selectedVariant ? ` - ${formatPrice(selectedVariant.price)}` : ''}`
        )}
      </button>

      {/* Error message */}
      {error && <p className="form-error mt-4" role="alert">{error}</p>}

      {/* Success toast */}
      {success && (
        <div className="toast toast--success is-visible" role="status" aria-live="polite">
          Added {productTitle} to your cart
        </div>
      )}
    </div>
  );
}
