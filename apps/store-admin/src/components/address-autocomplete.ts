/**
 * Address Autocomplete + Map Picker Component
 *
 * Features:
 * 1. Google Places Autocomplete on address input — suggests real addresses as user types
 * 2. Interactive Google Map picker — click to drop pin, reverse-geocode to fill address
 * 3. Graceful fallback — if no API key, fields are plain text inputs (still functional)
 *
 * Usage:
 *   import { addressFormHtml, addressAutocompleteScript, parseAddressFromBody }
 *     from '../components/address-autocomplete.js'
 */

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export interface AddressValues {
  first_name?: string
  last_name?: string
  company?: string
  address1?: string
  address2?: string
  city?: string
  province?: string
  province_code?: string
  country?: string
  country_code?: string
  zip?: string
  phone?: string
  lat?: string
  lng?: string
}

interface AddressFormOpts {
  prefix: string          // 'shipping' | 'billing'
  label: string           // 'Shipping Address' | 'Billing Address'
  values?: AddressValues
  disabled?: boolean
  compact?: boolean       // 2-column layout
  showMap?: boolean       // show interactive map (default true when apiKey present)
}

/**
 * Returns HTML for an address form section with autocomplete + map.
 */
export function addressFormHtml(opts: AddressFormOpts): string {
  const { prefix, label, values = {}, disabled = false, compact = false, showMap = true } = opts
  const d = disabled ? 'disabled' : ''
  const v = (field: keyof AddressValues) => esc(values[field] || '')

  const inputStyle = 'width:100%;padding:8px 10px;border:1px solid var(--s-border);border-radius:6px;background:var(--s-card);color:var(--s-text);font-size:13px;box-sizing:border-box'
  const labelStyle = 'display:block;font-size:12px;font-weight:500;color:var(--s-text-muted);margin-bottom:4px'

  return `
    <div class="addr-section" data-prefix="${prefix}">
      <h4 style="font-size:13px;font-weight:600;margin:0 0 12px 0;color:var(--s-text)">${esc(label)}</h4>

      ${compact ? '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">' : ''}
      <div style="margin-bottom:10px">
        <label style="${labelStyle}">First Name</label>
        <input type="text" name="${prefix}_first_name" value="${v('first_name')}" ${d} style="${inputStyle}" />
      </div>
      <div style="margin-bottom:10px">
        <label style="${labelStyle}">Last Name</label>
        <input type="text" name="${prefix}_last_name" value="${v('last_name')}" ${d} style="${inputStyle}" />
      </div>
      ${compact ? '</div>' : ''}

      <div style="margin-bottom:10px">
        <label style="${labelStyle}">Company (optional)</label>
        <input type="text" name="${prefix}_company" value="${v('company')}" ${d} style="${inputStyle}" />
      </div>

      <div style="margin-bottom:10px;position:relative">
        <label style="${labelStyle}">Address <span style="font-weight:400;color:var(--s-text-dim)">(type to search)</span></label>
        <input type="text" name="${prefix}_address1" id="${prefix}-address1" value="${v('address1')}" ${d}
          placeholder="Start typing address..."
          autocomplete="off"
          style="${inputStyle}" />
      </div>

      <div style="margin-bottom:10px">
        <label style="${labelStyle}">Apartment, suite, unit, etc.</label>
        <input type="text" name="${prefix}_address2" value="${v('address2')}" ${d} style="${inputStyle}" />
      </div>

      ${compact ? '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">' : ''}
      <div style="margin-bottom:10px">
        <label style="${labelStyle}">City</label>
        <input type="text" name="${prefix}_city" id="${prefix}-city" value="${v('city')}" ${d} style="${inputStyle}" />
      </div>
      <div style="margin-bottom:10px">
        <label style="${labelStyle}">Province / State</label>
        <input type="text" name="${prefix}_province" id="${prefix}-province" value="${v('province')}" ${d} style="${inputStyle}" />
      </div>
      ${compact ? '</div>' : ''}

      ${compact ? '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">' : ''}
      <div style="margin-bottom:10px">
        <label style="${labelStyle}">ZIP / Postal Code</label>
        <input type="text" name="${prefix}_zip" id="${prefix}-zip" value="${v('zip')}" ${d} style="${inputStyle}" />
      </div>
      <div style="margin-bottom:10px">
        <label style="${labelStyle}">Country</label>
        <input type="text" name="${prefix}_country" id="${prefix}-country" value="${v('country')}" ${d} style="${inputStyle}" />
      </div>
      ${compact ? '</div>' : ''}

      <div style="margin-bottom:10px">
        <label style="${labelStyle}">Phone</label>
        <input type="text" name="${prefix}_phone" value="${v('phone')}" ${d} style="${inputStyle}" placeholder="+84..." />
      </div>

      <!-- Map picker container -->
      ${showMap ? `
        <div style="margin-bottom:10px">
          <label style="${labelStyle}">Pick location on map <span style="font-weight:400;color:var(--s-text-dim)">(click to drop pin)</span></label>
          <div id="${prefix}-map" style="width:100%;height:250px;border-radius:8px;border:1px solid var(--s-border);background:var(--s-bg);display:flex;align-items:center;justify-content:center;color:var(--s-text-dim);font-size:12px">
            Loading map...
          </div>
          <div id="${prefix}-map-coords" style="font-size:11px;color:var(--s-text-dim);margin-top:4px;display:${values?.lat ? 'block' : 'none'}">
            ${values?.lat ? `Lat: ${v('lat')}, Lng: ${v('lng')}` : ''}
          </div>
        </div>
      ` : ''}

      <!-- Hidden fields -->
      <input type="hidden" name="${prefix}_province_code" id="${prefix}-province-code" value="${v('province_code')}" />
      <input type="hidden" name="${prefix}_country_code" id="${prefix}-country-code" value="${v('country_code')}" />
      <input type="hidden" name="${prefix}_lat" id="${prefix}-lat" value="${v('lat')}" />
      <input type="hidden" name="${prefix}_lng" id="${prefix}-lng" value="${v('lng')}" />
    </div>
  `
}

/**
 * Returns the <script> tag for Google Maps + Places Autocomplete + Map Picker.
 * Include once per page.
 */
export function addressAutocompleteScript(apiKey?: string): string {
  if (!apiKey) {
    return `
    <script>
    /* Google Maps API key not configured — showing helpful message */
    document.querySelectorAll('.addr-section').forEach(function(section) {
      var prefix = section.dataset.prefix;
      var mapEl = document.getElementById(prefix + '-map');
      if (mapEl) {
        mapEl.innerHTML = '<div style="text-align:center;padding:20px;color:var(--s-text-dim)"><div style="font-size:24px;margin-bottom:8px">&#128506;</div><div style="font-size:12px">Map requires Google Maps API key.<br/>Set <code>GOOGLE_PLACES_API_KEY</code> in .env</div></div>';
      }
    });
    </script>`
  }

  return `
    <script>
    (function() {
      /* ===== Load Google Maps JS API ===== */
      var script = document.createElement('script');
      script.src = 'https://maps.googleapis.com/maps/api/js?key=${esc(apiKey)}&libraries=places&callback=__gboxInitMaps';
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);

      window.__gboxInitMaps = function() {
        document.querySelectorAll('.addr-section').forEach(function(section) {
          var prefix = section.dataset.prefix;
          initAutocomplete(prefix);
          initMapPicker(prefix);
        });
      };

      /* ===== Places Autocomplete on address1 input ===== */
      function initAutocomplete(prefix) {
        var input = document.getElementById(prefix + '-address1');
        if (!input) return;

        var autocomplete = new google.maps.places.Autocomplete(input, {
          types: ['address'],
          fields: ['address_components', 'formatted_address', 'geometry']
        });

        autocomplete.addListener('place_changed', function() {
          var place = autocomplete.getPlace();
          if (!place || !place.address_components) return;

          var fields = { city: '', province: '', province_code: '', country: '', country_code: '', zip: '' };
          var streetNumber = '', route = '';

          place.address_components.forEach(function(c) {
            var t = c.types;
            if (t.includes('street_number')) streetNumber = c.long_name;
            if (t.includes('route')) route = c.long_name;
            if (t.includes('locality') || t.includes('sublocality_level_1') || t.includes('administrative_area_level_2')) fields.city = fields.city || c.long_name;
            if (t.includes('administrative_area_level_1')) { fields.province = c.long_name; fields.province_code = c.short_name; }
            if (t.includes('country')) { fields.country = c.long_name; fields.country_code = c.short_name; }
            if (t.includes('postal_code')) fields.zip = c.long_name;
          });

          /* Fill address */
          input.value = [streetNumber, route].filter(Boolean).join(' ');

          /* Fill other fields */
          setField(prefix + '-city', fields.city);
          setField(prefix + '-province', fields.province);
          setField(prefix + '-province-code', fields.province_code);
          setField(prefix + '-country', fields.country);
          setField(prefix + '-country-code', fields.country_code);
          setField(prefix + '-zip', fields.zip);

          /* Move map marker to selected address */
          if (place.geometry && place.geometry.location) {
            var lat = place.geometry.location.lat();
            var lng = place.geometry.location.lng();
            setField(prefix + '-lat', lat);
            setField(prefix + '-lng', lng);
            updateMap(prefix, lat, lng);
            showCoords(prefix, lat, lng);
          }
        });
      }

      /* ===== Interactive Map Picker ===== */
      var maps = {};   /* prefix -> { map, marker } */

      function initMapPicker(prefix) {
        var container = document.getElementById(prefix + '-map');
        if (!container) return;

        /* Default center: use existing coords, or Ho Chi Minh City */
        var latEl = document.getElementById(prefix + '-lat');
        var lngEl = document.getElementById(prefix + '-lng');
        var defaultLat = (latEl && latEl.value) ? parseFloat(latEl.value) : 10.7769;
        var defaultLng = (lngEl && lngEl.value) ? parseFloat(lngEl.value) : 106.7009;
        var hasExisting = (latEl && latEl.value && lngEl && lngEl.value);

        container.innerHTML = '';  /* clear "Loading map..." */

        var map = new google.maps.Map(container, {
          center: { lat: defaultLat, lng: defaultLng },
          zoom: hasExisting ? 16 : 12,
          mapTypeControl: false,
          streetViewControl: false,
          fullscreenControl: true,
          styles: getMapStyle()
        });

        var marker = new google.maps.Marker({
          position: hasExisting ? { lat: defaultLat, lng: defaultLng } : null,
          map: hasExisting ? map : null,
          draggable: true,
          animation: google.maps.Animation.DROP,
          title: 'Delivery location'
        });

        maps[prefix] = { map: map, marker: marker };

        /* Click map -> place/move marker + reverse geocode */
        map.addListener('click', function(e) {
          var lat = e.latLng.lat();
          var lng = e.latLng.lng();
          marker.setPosition(e.latLng);
          marker.setMap(map);
          setField(prefix + '-lat', lat);
          setField(prefix + '-lng', lng);
          showCoords(prefix, lat, lng);
          reverseGeocode(prefix, lat, lng);
        });

        /* Drag marker end -> reverse geocode */
        marker.addListener('dragend', function() {
          var pos = marker.getPosition();
          var lat = pos.lat();
          var lng = pos.lng();
          setField(prefix + '-lat', lat);
          setField(prefix + '-lng', lng);
          showCoords(prefix, lat, lng);
          reverseGeocode(prefix, lat, lng);
        });
      }

      /* Move map + marker to coordinates */
      function updateMap(prefix, lat, lng) {
        var m = maps[prefix];
        if (!m) return;
        var pos = new google.maps.LatLng(lat, lng);
        m.map.setCenter(pos);
        m.map.setZoom(16);
        m.marker.setPosition(pos);
        m.marker.setMap(m.map);
      }

      /* Reverse geocode: lat/lng -> fill address fields */
      function reverseGeocode(prefix, lat, lng) {
        var geocoder = new google.maps.Geocoder();
        geocoder.geocode({ location: { lat: lat, lng: lng } }, function(results, status) {
          if (status !== 'OK' || !results[0]) return;

          var place = results[0];
          var fields = { address1: '', city: '', province: '', province_code: '', country: '', country_code: '', zip: '' };
          var streetNumber = '', route = '';

          place.address_components.forEach(function(c) {
            var t = c.types;
            if (t.includes('street_number')) streetNumber = c.long_name;
            if (t.includes('route')) route = c.long_name;
            if (t.includes('locality') || t.includes('sublocality_level_1') || t.includes('administrative_area_level_2')) fields.city = fields.city || c.long_name;
            if (t.includes('administrative_area_level_1')) { fields.province = c.long_name; fields.province_code = c.short_name; }
            if (t.includes('country')) { fields.country = c.long_name; fields.country_code = c.short_name; }
            if (t.includes('postal_code')) fields.zip = c.long_name;
          });

          fields.address1 = [streetNumber, route].filter(Boolean).join(' ');

          /* Fill form */
          setField(prefix + '-address1', fields.address1);
          setField(prefix + '-city', fields.city);
          setField(prefix + '-province', fields.province);
          setField(prefix + '-province-code', fields.province_code);
          setField(prefix + '-country', fields.country);
          setField(prefix + '-country-code', fields.country_code);
          setField(prefix + '-zip', fields.zip);
        });
      }

      /* Show coordinates text */
      function showCoords(prefix, lat, lng) {
        var coordsEl = document.getElementById(prefix + '-map-coords');
        if (coordsEl) {
          coordsEl.style.display = 'block';
          coordsEl.textContent = 'Lat: ' + lat.toFixed(6) + ', Lng: ' + lng.toFixed(6);
        }
      }

      /* Set field value helper */
      function setField(id, val) {
        var el = document.getElementById(id);
        if (el) el.value = val || '';
      }

      /* Dark-friendly map style */
      function getMapStyle() {
        var isDark = document.documentElement.style.colorScheme === 'dark'
          || document.body.classList.contains('dark')
          || window.matchMedia('(prefers-color-scheme: dark)').matches;

        if (!isDark) return [];
        return [
          { elementType: 'geometry', stylers: [{ color: '#242f3e' }] },
          { elementType: 'labels.text.stroke', stylers: [{ color: '#242f3e' }] },
          { elementType: 'labels.text.fill', stylers: [{ color: '#746855' }] },
          { featureType: 'administrative.locality', elementType: 'labels.text.fill', stylers: [{ color: '#d59563' }] },
          { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#38414e' }] },
          { featureType: 'road', elementType: 'geometry.stroke', stylers: [{ color: '#212a37' }] },
          { featureType: 'road', elementType: 'labels.text.fill', stylers: [{ color: '#9ca5b3' }] },
          { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#746855' }] },
          { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#17263c' }] },
          { featureType: 'water', elementType: 'labels.text.fill', stylers: [{ color: '#515c6d' }] },
          { featureType: 'poi', elementType: 'labels', stylers: [{ visibility: 'off' }] },
          { featureType: 'transit', stylers: [{ visibility: 'off' }] },
        ];
      }

    })();
    </script>
  `
}

/**
 * Parse address form fields from request body into AddressValues object.
 */
export function parseAddressFromBody(body: Record<string, any>, prefix: string): AddressValues | null {
  const addr1 = body[`${prefix}_address1`]?.trim()
  if (!addr1) return null

  return {
    first_name: body[`${prefix}_first_name`]?.trim() || '',
    last_name: body[`${prefix}_last_name`]?.trim() || '',
    company: body[`${prefix}_company`]?.trim() || '',
    address1: addr1,
    address2: body[`${prefix}_address2`]?.trim() || '',
    city: body[`${prefix}_city`]?.trim() || '',
    province: body[`${prefix}_province`]?.trim() || '',
    province_code: body[`${prefix}_province_code`]?.trim() || '',
    country: body[`${prefix}_country`]?.trim() || '',
    country_code: body[`${prefix}_country_code`]?.trim() || '',
    zip: body[`${prefix}_zip`]?.trim() || '',
    phone: body[`${prefix}_phone`]?.trim() || '',
    lat: body[`${prefix}_lat`]?.trim() || '',
    lng: body[`${prefix}_lng`]?.trim() || '',
  }
}
