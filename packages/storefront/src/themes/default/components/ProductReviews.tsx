/**
 * ProductReviews — React island for displaying and submitting product reviews.
 *
 * Features:
 *   - Average rating display with star icons
 *   - Rating distribution bars (5 bars showing percentage)
 *   - Review list with author avatar, name, date, stars, title, body
 *   - "Write a Review" expandable form
 *   - "Load More" pagination
 */

import { useState, useCallback } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Review {
  id: string;
  author_name: string;
  rating: number;
  title: string | null;
  body: string;
  created_at: string;
}

interface ReviewStats {
  average: number;
  count: number;
  distribution: Record<number, number>;
}

interface Props {
  productId: string;
  initialReviews: Review[];
  initialTotal: number;
  initialStats: ReviewStats;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function StarIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      className={`review-star ${filled ? 'review-star--filled' : 'review-star--empty'}`}
      viewBox="0 0 20 20"
      width="18"
      height="18"
      aria-hidden="true"
    >
      <path
        d="M10 1l2.39 4.84 5.34.78-3.87 3.77.91 5.32L10 13.27l-4.77 2.51.91-5.32L2.27 6.69l5.34-.78L10 1z"
        fill={filled ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="1"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function StarRating({ rating, size = 'md' }: { rating: number; size?: 'sm' | 'md' }) {
  return (
    <span className={`star-rating star-rating--${size}`} aria-label={`${rating} out of 5 stars`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <StarIcon key={n} filled={n <= rating} />
      ))}
    </span>
  );
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function AuthorAvatar({ name }: { name: string }) {
  const initial = (name.charAt(0) || '?').toUpperCase();
  return <span className="review-avatar">{initial}</span>;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function RatingDistribution({ stats }: { stats: ReviewStats }) {
  const { distribution, count } = stats;

  return (
    <div className="rating-distribution">
      {[5, 4, 3, 2, 1].map((star) => {
        const starCount = distribution[star] ?? 0;
        const pct = count > 0 ? (starCount / count) * 100 : 0;
        return (
          <div key={star} className="rating-distribution__row">
            <span className="rating-distribution__label">{star} star</span>
            <div className="rating-distribution__bar-bg">
              <div
                className="rating-distribution__bar-fill"
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="rating-distribution__count">{starCount}</span>
          </div>
        );
      })}
    </div>
  );
}

function ReviewItem({ review }: { review: Review }) {
  return (
    <div className="review-item">
      <div className="review-item__header">
        <AuthorAvatar name={review.author_name} />
        <div className="review-item__meta">
          <span className="review-item__author">{review.author_name}</span>
          <span className="review-item__date">{formatDate(review.created_at)}</span>
        </div>
        <StarRating rating={review.rating} size="sm" />
      </div>
      {review.title && <h4 className="review-item__title">{review.title}</h4>}
      <p className="review-item__body">{review.body}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Review Form
// ---------------------------------------------------------------------------

interface ReviewFormProps {
  productId: string;
  onSubmitted: (review: Review) => void;
}

function ReviewForm({ productId, onSubmitted }: ReviewFormProps) {
  const [rating, setRating] = useState(0);
  const [hoverRating, setHoverRating] = useState(0);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [authorName, setAuthorName] = useState('');
  const [authorEmail, setAuthorEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError('');

      if (rating === 0) {
        setError('Please select a rating');
        return;
      }
      if (!body.trim()) {
        setError('Please write a review');
        return;
      }
      if (!authorName.trim()) {
        setError('Please enter your name');
        return;
      }
      if (!authorEmail.trim()) {
        setError('Please enter your email');
        return;
      }

      setSubmitting(true);

      try {
        const res = await fetch(`/api/2026-04/products/${productId}/reviews.json`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            review: {
              author_name: authorName,
              author_email: authorEmail,
              rating,
              title: title || null,
              body,
            },
          }),
        });

        if (!res.ok) {
          const data = await res.json().catch(() => null);
          throw new Error(data?.errors?.[0] ?? 'Failed to submit review');
        }

        const data = await res.json();
        onSubmitted(data.review);
        setSuccess(true);

        // Reset form
        setRating(0);
        setTitle('');
        setBody('');
        setAuthorName('');
        setAuthorEmail('');
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Something went wrong');
      } finally {
        setSubmitting(false);
      }
    },
    [productId, rating, title, body, authorName, authorEmail, onSubmitted],
  );

  if (success) {
    return (
      <div className="review-form__success" role="status">
        Thank you for your review! It will appear once approved.
      </div>
    );
  }

  return (
    <form className="review-form" onSubmit={handleSubmit}>
      {/* Star rating selector */}
      <fieldset className="review-form__rating">
        <legend className="review-form__label">Your Rating</legend>
        <div className="review-form__stars">
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              type="button"
              className="review-form__star-btn"
              onMouseEnter={() => setHoverRating(n)}
              onMouseLeave={() => setHoverRating(0)}
              onClick={() => setRating(n)}
              aria-label={`Rate ${n} star${n > 1 ? 's' : ''}`}
            >
              <StarIcon filled={n <= (hoverRating || rating)} />
            </button>
          ))}
        </div>
      </fieldset>

      {/* Title */}
      <div className="review-form__field">
        <label className="review-form__label" htmlFor="review-title">
          Title (optional)
        </label>
        <input
          id="review-title"
          type="text"
          className="form-input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Summarize your experience"
          maxLength={200}
        />
      </div>

      {/* Body */}
      <div className="review-form__field">
        <label className="review-form__label" htmlFor="review-body">
          Review
        </label>
        <textarea
          id="review-body"
          className="form-textarea"
          rows={4}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Tell others about your experience"
          required
        />
      </div>

      {/* Author name */}
      <div className="review-form__field">
        <label className="review-form__label" htmlFor="review-name">
          Name
        </label>
        <input
          id="review-name"
          type="text"
          className="form-input"
          value={authorName}
          onChange={(e) => setAuthorName(e.target.value)}
          placeholder="Your name"
          required
        />
      </div>

      {/* Author email */}
      <div className="review-form__field">
        <label className="review-form__label" htmlFor="review-email">
          Email
        </label>
        <input
          id="review-email"
          type="email"
          className="form-input"
          value={authorEmail}
          onChange={(e) => setAuthorEmail(e.target.value)}
          placeholder="your@email.com"
          required
        />
      </div>

      {error && <p className="form-error" role="alert">{error}</p>}

      <button
        type="submit"
        className="btn btn--primary"
        disabled={submitting}
        aria-busy={submitting}
      >
        {submitting ? 'Submitting...' : 'Submit Review'}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function ProductReviews({
  productId,
  initialReviews,
  initialTotal,
  initialStats,
}: Props) {
  const [reviews, setReviews] = useState<Review[]>(initialReviews);
  const [total, setTotal] = useState(initialTotal);
  const [stats, setStats] = useState<ReviewStats>(initialStats);
  const [showForm, setShowForm] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [page, setPage] = useState(1);

  const hasMore = reviews.length < total;

  const loadMore = useCallback(async () => {
    setLoadingMore(true);
    const nextPage = page + 1;
    try {
      const params = new URLSearchParams({
        page: String(nextPage),
        limit: '20',
      });
      const res = await fetch(
        `/api/2026-04/products/${productId}/reviews.json?${params.toString()}`,
      );
      if (!res.ok) throw new Error('Failed to load reviews');
      const data = await res.json();
      setReviews((prev) => [...prev, ...data.reviews]);
      setTotal(data.total);
      setPage(nextPage);
    } catch {
      // silently fail
    } finally {
      setLoadingMore(false);
    }
  }, [page, productId]);

  const handleReviewSubmitted = useCallback((_review: Review) => {
    // New reviews go to moderation, so just update the stats count optimistically
    setStats((prev) => ({
      ...prev,
      count: prev.count + 1,
    }));
  }, []);

  return (
    <section className="product-reviews" aria-labelledby="reviews-heading">
      <h2 id="reviews-heading" className="product-reviews__heading">
        Customer Reviews
      </h2>

      {/* Summary */}
      <div className="product-reviews__summary">
        <div className="product-reviews__average">
          <span className="product-reviews__average-number">
            {stats.average.toFixed(1)}
          </span>
          <StarRating rating={Math.round(stats.average)} />
          <span className="product-reviews__count">
            Based on {stats.count} review{stats.count !== 1 ? 's' : ''}
          </span>
        </div>

        <RatingDistribution stats={stats} />

        <button
          type="button"
          className="btn btn--secondary"
          onClick={() => setShowForm((prev) => !prev)}
        >
          {showForm ? 'Cancel' : 'Write a Review'}
        </button>
      </div>

      {/* Write a Review form */}
      {showForm && (
        <div className="product-reviews__form-wrapper">
          <ReviewForm productId={productId} onSubmitted={handleReviewSubmitted} />
        </div>
      )}

      {/* Reviews list */}
      <div className="product-reviews__list">
        {reviews.length === 0 ? (
          <p className="product-reviews__empty">
            No reviews yet. Be the first to review this product!
          </p>
        ) : (
          reviews.map((review) => <ReviewItem key={review.id} review={review} />)
        )}
      </div>

      {/* Load More */}
      {hasMore && (
        <div className="product-reviews__load-more">
          <button
            type="button"
            className="btn btn--outline"
            onClick={loadMore}
            disabled={loadingMore}
            aria-busy={loadingMore}
          >
            {loadingMore ? (
              <span className="flex items-center justify-center gap-2">
                <span className="loading-spinner" />
                Loading...
              </span>
            ) : (
              'Load More Reviews'
            )}
          </button>
        </div>
      )}
    </section>
  );
}
