/* eslint-disable */
/**
 * Gbox Checkout — bootstrap script
 *
 * Loaded by the payment step (Step 3) as a same-origin external script
 * so the strict CSP (no 'unsafe-inline') can still run one small
 * initializer. This file:
 *
 *   1. Reads checkout metadata from #gbox-checkout-meta data-attributes
 *      (the server already inserted them — we do NOT parse HTML or
 *       generate markup here).
 *   2. Fetches the PayPal SDK script tag from the Platform API:
 *        GET /api/store/:slug/payments/paypal-partner/sdk-tag
 *      The endpoint is served with Cache-Control so repeated visits
 *      are cheap. The response includes { script_tag, src, bn_code,
 *      merchant_id } — we only use `src` here and build our own
 *      <script> element so the CSP can validate the exact attributes.
 *   3. Waits for window.paypal to be ready, then renders PayPal + Venmo
 *      buttons with createOrder/onApprove handlers that POST back to
 *      our slug-less wrappers:
 *        POST /api/checkout/:id/paypal/create
 *        POST /api/checkout/:id/paypal/capture
 *   4. On successful capture, 302s to the thank-you page.
 *
 * Hard rules:
 *   - No inline script. All behaviour lives here and only here.
 *   - No third-party libraries other than the official PayPal SDK.
 *   - All network calls are cross-origin to api.gbox.co — the CSP's
 *     connect-src allows this.
 *   - Every failure path shows the buyer a readable message (not a
 *     silent failure or console log).
 */
(function () {
  'use strict';
  if (typeof document === 'undefined') return;

  function log() {
    // eslint-disable-next-line no-console
    try { console.info.apply(console, ['[gbox-checkout]'].concat([].slice.call(arguments))); } catch (_) {}
  }

  function setStatus(text, isError) {
    var el = document.getElementById('gbox-pay-status');
    if (!el) return;
    el.textContent = text;
    el.style.color = isError ? 'var(--error)' : 'var(--muted)';
  }

  var metaEl = document.getElementById('gbox-checkout-meta');
  if (!metaEl) {
    log('no meta element — not on payment step');
    return;
  }

  var meta = {
    checkoutId:     metaEl.getAttribute('data-checkout-id'),
    shopSlug:       metaEl.getAttribute('data-shop-slug'),
    currency:       metaEl.getAttribute('data-currency') || 'USD',
    country:        metaEl.getAttribute('data-country') || 'US',
    total:          metaEl.getAttribute('data-total') || '0.00',
    thankyouUrl:    metaEl.getAttribute('data-thankyou-url'),
    paypalSdkUrl:   metaEl.getAttribute('data-paypal-sdk-url'),
    paypalCreateUrl:metaEl.getAttribute('data-paypal-create-url'),
    paypalCaptureUrl:metaEl.getAttribute('data-paypal-capture-url'),
  };

  // The Platform API is cross-origin in production (api.gbox.co). The
  // relative URLs above are resolved against a base that the server
  // leaves on the <base>-less document — which defaults to
  // https://checkout.gbox.co. That WON'T hit api.gbox.co. So we need an
  // absolute base for API calls. We read it from a <meta> tag if the
  // server provided one, else fall back to same-origin (which is fine
  // for local dev where apps/checkout sits behind the same reverse
  // proxy as the API).
  var apiBase = (function () {
    var m = document.querySelector('meta[name="gbox-api-base"]');
    if (m) return m.getAttribute('content') || '';
    // Convention: production API lives on api.<checkout-host-stripped>
    // e.g. checkout.gbox.co → api.gbox.co. Dev/staging overrides via
    // the meta tag above.
    try {
      var host = location.hostname;
      if (host.indexOf('checkout.') === 0) {
        return location.protocol + '//' + host.replace(/^checkout\./, 'api.');
      }
    } catch (_) {}
    return '';
  })();

  function apiUrl(path) {
    return apiBase + path;
  }

  function fetchJson(url, opts) {
    opts = opts || {};
    opts.credentials = 'include';
    opts.headers = Object.assign(
      { Accept: 'application/json' },
      opts.headers || {},
    );
    if (opts.body && typeof opts.body === 'object') {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(opts.body);
    }
    return fetch(url, opts).then(function (res) {
      return res.json().then(
        function (data) {
          if (!res.ok) {
            var err = new Error((data && data.message) || 'HTTP ' + res.status);
            err.status = res.status;
            err.data = data;
            throw err;
          }
          return data;
        },
        function () {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return null;
        },
      );
    });
  }

  function loadPaypalSdk() {
    if (window.paypal && window.paypal.Buttons) {
      return Promise.resolve(window.paypal);
    }
    setStatus('Loading secure payment…');
    return fetchJson(
      apiUrl(meta.paypalSdkUrl + '?country=' + encodeURIComponent(meta.country)),
      { method: 'GET' },
    ).then(function (data) {
      if (!data || !data.paypal_sdk || !data.paypal_sdk.src) {
        throw new Error('PayPal SDK not available');
      }
      var sdk = data.paypal_sdk;
      return new Promise(function (resolve, reject) {
        var s = document.createElement('script');
        s.src = sdk.src;
        s.setAttribute('data-partner-attribution-id', sdk.bn_code || 'Gbox_Ecom');
        if (sdk.merchant_id) s.setAttribute('data-merchant-id', sdk.merchant_id);
        s.onload = function () {
          if (window.paypal) resolve(window.paypal);
          else reject(new Error('PayPal SDK loaded but window.paypal missing'));
        };
        s.onerror = function () {
          reject(new Error('PayPal SDK failed to load'));
        };
        document.head.appendChild(s);
      });
    });
  }

  function mountButtons(paypal) {
    var container = document.getElementById('gbox-paypal-buttons');
    if (!container) return;
    container.innerHTML = '';
    setStatus('Choose a payment method');

    function buildBaseConfig(paymentMethod) {
      return {
        style: {
          layout: 'vertical',
          shape: 'rect',
          label: paymentMethod === 'venmo' ? 'venmo' : 'paypal',
        },
        createOrder: function () {
          setStatus('Creating order…');
          return fetchJson(apiUrl(meta.paypalCreateUrl), {
            method: 'POST',
            body: { payment_method: paymentMethod },
          }).then(function (data) {
            if (!data || !data.paypal_order || !data.paypal_order.id) {
              throw new Error('PayPal order creation failed');
            }
            return data.paypal_order.id;
          }).catch(function (err) {
            log('createOrder failed', err);
            setStatus('Could not start payment: ' + err.message, true);
            throw err;
          });
        },
        onApprove: function (data) {
          setStatus('Confirming payment…');
          return fetchJson(apiUrl(meta.paypalCaptureUrl), {
            method: 'POST',
            body: { paypal_order_id: data.orderID },
          }).then(function (result) {
            if (result && result.order_id) {
              setStatus('Payment confirmed! Redirecting…');
              window.location.href = meta.thankyouUrl;
            } else if (result && result.warning === 'payment_captured_finalize_pending') {
              setStatus(
                'Payment captured but order finalization is still pending. We\u2019ll email you when it\u2019s ready.',
                true,
              );
            } else {
              setStatus('Payment status unclear — please contact support.', true);
            }
          }).catch(function (err) {
            log('capture failed', err);
            if (err.status === 422) {
              setStatus('Payment declined. Please try another method.', true);
            } else {
              setStatus('Could not confirm payment: ' + err.message, true);
            }
          });
        },
        onCancel: function () {
          setStatus('Payment cancelled. You can try again.');
        },
        onError: function (err) {
          log('PayPal button error', err);
          setStatus('Payment failed: ' + (err && err.message ? err.message : 'unknown error'), true);
        },
      };
    }

    try {
      paypal.Buttons(buildBaseConfig('paypal')).render('#gbox-paypal-buttons');
    } catch (err) {
      log('paypal button render failed', err);
      setStatus('PayPal is unavailable right now.', true);
      return;
    }

    // Venmo button — only render on mobile / supported UAs. The SDK
    // exposes `paypal.FUNDING.VENMO` and isEligible(). Silent fallback
    // if not supported.
    try {
      if (paypal.FUNDING && paypal.FUNDING.VENMO) {
        var venmoCfg = buildBaseConfig('venmo');
        venmoCfg.fundingSource = paypal.FUNDING.VENMO;
        var venmoBtn = paypal.Buttons(venmoCfg);
        if (venmoBtn.isEligible && venmoBtn.isEligible()) {
          venmoBtn.render('#gbox-paypal-buttons');
        }
      }
    } catch (err) {
      log('venmo button skipped', err && err.message);
    }
  }

  log('init — loading PayPal SDK');
  loadPaypalSdk()
    .then(mountButtons)
    .catch(function (err) {
      log('SDK init failed', err);
      setStatus(
        'Payment unavailable: ' + (err && err.message ? err.message : 'unknown'),
        true,
      );
    });
})();
