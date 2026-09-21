// PodVet Website Color Picker
// Injected into the Settings -> Profile screen. Lets the user pick any color
// with an MS Office "More Colors"-style hexagon honeycomb grid + brightness
// slider, and applies it site-wide by overriding the --brand-* CSS variables.
// The choice is stored in localStorage and pushed to the clinic's brandColor.
(function () {
  if (window.__pvThemeInit) return;
  window.__pvThemeInit = true;

  var STORE_KEY = 'pvBrandColor';
  var DEFAULT_HEX = '#92CAED';

  // -- color helpers ---------------------------------------------------------
  function hexToHsl(hex) {
    hex = (hex || '').replace('#', '');
    if (hex.length === 3) hex = hex.split('').map(function (c) { return c + c; }).join('');
    var r = parseInt(hex.slice(0, 2), 16) / 255;
    var g = parseInt(hex.slice(2, 4), 16) / 255;
    var b = parseInt(hex.slice(4, 6), 16) / 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b);
    var h = 0, s = 0, l = (max + min) / 2;
    var d = max - min;
    if (d) {
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r: h = ((g - b) / d + (g < b ? 6 : 0)); break;
        case g: h = (b - r) / d + 2; break;
        case b: h = (r - g) / d + 4; break;
      }
      h *= 60;
    }
    return { h: Math.round(h) % 360, s: Math.round(s * 100), l: Math.round(l * 100) };
  }

  // Build the --brand-50..900 ramp so the picked color lands on --brand-500.
  function rampFromHsl(h, s, l) {
    var deltas = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900];
    var lDelta = { 50: 30, 100: 26, 200: 22, 300: 17, 400: 11, 500: 0, 600: -8, 700: -14, 800: -20, 900: -26 };
    return deltas.map(function (slot) {
      var ll = Math.max(6, Math.min(96, l + lDelta[slot]));
      return { slot: slot, hsl: { h: h, s: s, l: ll } };
    });
  }
  function hslToRgb(h, s, l) {
    s /= 100; l /= 100;
    var c = (1 - Math.abs(2 * l - 1)) * s;
    var hp = h / 60;
    var x = c * (1 - Math.abs((hp % 2) - 1));
    var r = 0, g = 0, b = 0;
    if (hp >= 0 && hp < 1) { r = c; g = x; }
    else if (hp < 2) { r = x; g = c; }
    else if (hp < 3) { g = c; b = x; }
    else if (hp < 4) { g = x; b = c; }
    else if (hp < 5) { r = x; b = c; }
    else { r = c; b = x; }
    var m = l - c / 2;
    r = Math.round((r + m) * 255); g = Math.round((g + m) * 255); b = Math.round((b + m) * 255);
    return '#' + [r, g, b].map(function (v) { return v.toString(16).padStart(2, '0'); }).join('');
  }

  function applyBrand(hsl, save) {
    var ramp = rampFromHsl(hsl.h, Math.max(55, hsl.s), hsl.l);
    var root = document.documentElement;
    ramp.forEach(function (step) { root.style.setProperty('--brand-' + step.slot, hslToRgb(step.hsl.h, step.hsl.s, step.hsl.l)); });
    if (save) {
      try { localStorage.setItem(STORE_KEY, hslToRgb(hsl.h, hsl.s, hsl.l)); } catch (_) {}
      if (window.electronAPI && window.electronAPI.brandingUpdate) {
        window.electronAPI.brandingUpdate({ color: hslToRgb(hsl.h, hsl.s, hsl.l) }).catch(function () {});
      }
    }
    var sw = document.getElementById('pv-theme-swatch');
    if (sw) sw.style.backgroundColor = hslToRgb(hsl.h, hsl.s, hsl.l);
  }

  function resetBrand() {
    try { localStorage.removeItem(STORE_KEY); } catch (_) {}
    var RAMP = { 50: '#f6fbfe', 100: '#eaf6fd', 200: '#d4ecfa', 300: '#b6def6', 400: '#a4d4f1', 500: '#92caed', 600: '#6fb9e7', 700: '#55ace2', 800: '#3b9fde', 900: '#2492d6' };
    var root = document.documentElement;
    Object.keys(RAMP).forEach(function (slot) { root.style.setProperty('--brand-' + slot, RAMP[slot]); });
    if (window.electronAPI && window.electronAPI.brandingUpdate) {
      window.electronAPI.brandingUpdate({ color: null }).catch(function () {});
    }
    var sw = document.getElementById('pv-theme-swatch');
    if (sw) sw.style.backgroundColor = DEFAULT_HEX;
  }

  // -- dropdown panel --------------------------------------------------------
  var panelOpen = false;
  var pickerApi = null;

  function closePanel() {
    panelOpen = false;
    var p = document.getElementById('pv-theme-panel');
    if (p) p.style.display = 'none';
  }
  document.addEventListener('click', function () { closePanel(); });

  function openPanel(anchor) {
    panelOpen = true;
    var existing = document.getElementById('pv-theme-panel');
    var panel = existing || document.createElement('div');
    panel.id = 'pv-theme-panel';
    panel.style.cssText = 'position:static;z-index:9999;background:#fff;border:1px solid #e2e8f0;border-radius:12px;box-shadow:0 12px 32px rgba(15,23,42,.18);margin-top:8px;width:300px;padding:10px;display:block;';
    if (!existing) {
      panel.innerHTML = '';

      if (window.PodVetColorPicker) {
        var holder = document.createElement('div');
        panel.appendChild(holder);
        pickerApi = window.PodVetColorPicker.init(holder, {
          value: currentStored() || DEFAULT_HEX,
          onChangeLive: function (hex) { applyBrand(hexToHsl(hex), false); },
          onChangeCommit: function (hex) { applyBrand(hexToHsl(hex), true); seedSwatchFromStored(); }
        });
      }

      var footer = document.createElement('div');
      footer.style.cssText = 'display:flex;align-items:center;justify-content:flex-end;gap:8px;padding-top:8px;border-top:1px solid #f1f5f9;';
      var reset = document.createElement('button');
      reset.type = 'button';
      reset.textContent = 'Reset to Blue';
      reset.style.cssText = 'font-size:11px;color:#4a7fbc;background:none;border:none;cursor:pointer;padding:3px 6px;';
      reset.addEventListener('click', function (e) {
        e.stopPropagation();
        resetBrand();
        if (pickerApi) pickerApi.setValue(DEFAULT_HEX);
        seedSwatchFromStored();
      });
      footer.appendChild(reset);
      panel.appendChild(footer);

      anchor.parentElement.appendChild(panel);
    } else {
      panel.style.display = 'block';
      if (pickerApi) pickerApi.setValue(currentStored() || DEFAULT_HEX);
    }

    var handler = function (e) { if (!panel.contains(e.target) && !anchor.contains(e.target)) closePanel(); };
    setTimeout(function () { document.addEventListener('click', handler); }, 0);
  }

  function currentStored() {
    try { return localStorage.getItem(STORE_KEY) || null; } catch (_) { return null; }
  }
  function seedSwatchFromStored() {
    var h = currentStored() || DEFAULT_HEX;
    var sw = document.getElementById('pv-theme-swatch');
    if (sw) sw.style.backgroundColor = h;
  }

  // -- inject section into Settings -> Profile -------------------------------
  function buildSection(currentHex) {
    var sec = document.createElement('div');
    sec.id = 'pv-theme-section';

    var h3 = document.createElement('h3');
    h3.className = 'text-lg font-bold text-slate-800';
    h3.textContent = 'Website Color';
    sec.appendChild(h3);

    var p = document.createElement('p');
    p.className = 'text-xs text-slate-500 mt-0.5';
    p.textContent = 'Pick any color for the site. Hexagon palette with all hues, a brightness slider, and hex / RGB / HSL values — like MS Word.';
    sec.appendChild(p);

    var wrap = document.createElement('div');
    wrap.style.cssText = 'position:relative;margin-top:12px;';
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'pv-theme-btn';
    btn.style.cssText = 'display:inline-flex;align-items:center;gap:10px;padding:9px 14px;border:1px solid #e2e8f0;border-radius:12px;background:#fff;cursor:pointer;box-shadow:0 1px 2px rgba(15,23,42,.05);font-size:13px;color:#334155;';
    var sw = document.createElement('span');
    sw.id = 'pv-theme-swatch';
    sw.style.cssText = 'width:20px;height:20px;border-radius:6px;border:1px solid rgba(0,0,0,.1);display:inline-block;';
    sw.style.backgroundColor = currentHex || DEFAULT_HEX;
    var label = document.createElement('span');
    label.textContent = 'Change color';
    btn.appendChild(sw);
    btn.appendChild(label);
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (panelOpen) { closePanel(); } else { openPanel(btn); }
    });
    wrap.appendChild(btn);
    sec.appendChild(wrap);
    return sec;
  }

  // -- DOM injection with re-insertion on React re-render ---------------------
  function ensureInjected() {
    if (document.getElementById('pv-theme-section')) return;
    var headings = document.querySelectorAll('h3');
    var target = null;
    headings.forEach(function (h) {
      if (h.textContent && h.textContent.trim() === 'Profile Information') target = h;
    });
    if (!target) return;
    var holder = target.parentElement;
    if (!holder) return;
    var currentHex = currentStored();
    var sec = buildSection(currentHex || DEFAULT_HEX);
    holder.parentElement.insertBefore(sec, holder.nextSibling);

    if (currentHex) applyBrand(hexToHsl(currentHex), false);
    else if (window.electronAPI && window.electronAPI.brandingGet) {
      window.electronAPI.brandingGet().then(function (r) {
        if (r && r.success && r.branding && r.branding.color) {
          try { localStorage.setItem(STORE_KEY, r.branding.color); } catch (_) {}
          applyBrand(hexToHsl(r.branding.color), false);
          seedSwatchFromStored();
        }
      }).catch(function () {});
    }
  }

  // Apply stored brand on every load.
  try {
    var stored = localStorage.getItem(STORE_KEY);
    if (stored) applyBrand(hexToHsl(stored), false);
  } catch (_) {}

  var observer = new MutationObserver(function () { ensureInjected(); });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  ensureInjected();
})();