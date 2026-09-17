/* ===========================================================================
 * PetVetColorPicker — MS Office "More Colors"-style palette shown as columns.
 * Self-contained vanilla JS. Usage:
 *    PetVetColorPicker.init(containerEl, {
 *      value: '#93CAED',          // initial color
 *      onChangeLive: fn(hex),     // fired on scrub
 *      onChangeCommit: fn(hex)    // fired on click / slider release / hex Add
 *    });
 * Exposes window.PetVetColorPicker. No dependencies.
 * =========================================================================== */
(function (global) {
  'use strict';
  if (global.PetVetColorPicker) return;

  /* ---------------- color math ---------------- */
  function hue2rgb(p, q, t) {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  }
  function hslToRgb(h, s, l) {
    h = ((h % 360) + 360) % 360 / 360; s /= 100; l /= 100;
    var r, g, b;
    if (s === 0) { r = g = b = l; }
    else {
      var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      var p = 2 * l - q;
      r = hue2rgb(p, q, h + 1 / 3);
      g = hue2rgb(p, q, h);
      b = hue2rgb(p, q, h - 1 / 3);
    }
    return [Math.round(Math.min(255, Math.max(0, r * 255))), Math.round(Math.min(255, Math.max(0, g * 255))), Math.round(Math.min(255, Math.max(0, b * 255)))];
  }
  function rgbToHex(r, g, b) {
    function two(x) { x = Math.round(Math.min(255, Math.max(0, x))); return ('0' + x.toString(16)).slice(-2); }
    return '#' + two(r) + two(g) + two(b);
  }
  function hslToHex(h, s, l) { var a = hslToRgb(h, s, l); return rgbToHex(a[0], a[1], a[2]); }
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
        default: h = (r - g) / d + 4; break;
      }
      h *= 60;
    }
    h = Math.round(h); s = Math.round(s * 100); l = Math.round(l * 100);
    return { h: h === 360 ? 0 : h, s: s, l: l };
  }
  function normalizeHex(v) {
    v = (v || '').trim().replace(/^#/, '').toUpperCase();
    if (/^[0-9A-F]{3}$/.test(v)) { v = v[0] + v[0] + v[1] + v[1] + v[2] + v[2]; }
    return /^[0-9A-F]{6}$/.test(v) ? '#' + v : null;
  }

  /* ---------------- palette (columns) ----------------
   * 12 hue columns × 5 lightness shades each = 60 swatches, laid out so each
   * column is one hue family (light shades at top, dark at bottom). */
  var HUE_COLS = 12;          // every 30°
  var SHADE_ROWS = 5;         // lightness 18 … 84
  var SHADE_LIGHTS = [84, 68, 55, 42, 27];

  function buildSwatch(col, row) {
    var hue = Math.round(col * (360 / HUE_COLS));
    var sat = SHADE_LIGHTS[row] > 80 ? 55 : 78;
    var light = SHADE_LIGHTS[row];
    return { col: col, row: row, h: hue, s: sat, l: light, hex: hslToHex(hue, sat, light) };
  }
  function buildPalette() {
    var out = [];
    for (var c = 0; c < HUE_COLS; c++) {
      for (var r = 0; r < SHADE_ROWS; r++) out.push(buildSwatch(c, r));
    }
    return out;
  }

  function nearestSwatch(palette, h, s) {
    var best = palette[0], bd = Infinity;
    palette.forEach(function (w) {
      var dh = Math.abs(w.h - h); dh = Math.min(dh, 360 - dh);
      var d = dh * 1.2 + Math.abs(w.l - Math.max(18, Math.min(84, s * 0.6))) * 0.5;
      if (d < bd) { bd = d; best = w; }
    });
    return best;
  }

  /* ---------------- styles (injected once) ---------------- */
  function ensureStyles() {
    if (document.getElementById('pvc-style')) return;
    var st = document.createElement('style');
    st.id = 'pvc-style';
    st.textContent = [
      '.pvc{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#334155;width:100%;max-width:320px;}',
      '.pvc-top{font-size:11px;font-weight:700;letter-spacing:.03em;color:#64748b;text-transform:uppercase;padding:4px 2px 6px;}',
      '.pvc-grid{display:grid;grid-template-columns:repeat(12,1fr);gap:4px;padding:2px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;}',
      '.pvc-cell{appearance:none;border:1px solid rgba(15,23,42,.12);border-radius:4px;aspect-ratio:1;min-width:0;padding:0;margin:0;cursor:pointer;transition:transform .08s ease,box-shadow .08s ease,outline-color .08s ease;}',
      '.pvc-cell:hover{transform:scale(1.14);box-shadow:0 1px 4px rgba(15,23,42,.35);z-index:2;}',
      '.pvc-cell.sel{outline:2px solid #0f172a;outline-offset:2px;transform:scale(1.14);box-shadow:0 1px 5px rgba(15,23,42,.45);}',
      '.pvc-slider-wrap{display:flex;align-items:center;gap:8px;margin-top:10px;}',
      '.pvc-slider{flex:1;-webkit-appearance:none;appearance:none;height:14px;border-radius:8px;border:1px solid rgba(15,23,42,.12);outline:none;cursor:pointer;background:#eee;}',
      '.pvc-slider::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:22px;height:22px;border-radius:50%;background:#fff;border:2px solid #475569;box-shadow:0 1px 4px rgba(15,23,42,.35);cursor:pointer;}',
      '.pvc-slider::-moz-range-thumb{width:18px;height:18px;border-radius:50%;background:#fff;border:2px solid #475569;box-shadow:0 1px 4px rgba(15,23,42,.35);cursor:pointer;}',
      '.pvc-slider-label{font-size:10px;color:#94a3b8;white-space:nowrap;user-select:none;}',
      '.pvc-values{display:flex;gap:12px;align-items:center;margin-top:12px;}',
      '.pvc-swatch{width:62px;height:62px;border-radius:10px;border:1px solid rgba(15,23,42,.18);box-shadow:inset 0 1px 0 rgba(255,255,255,.35),0 2px 6px rgba(15,23,42,.15);flex:none;}',
      '.pvc-data{flex:1;min-width:0;}',
      '.pvc-hexrow{display:flex;align-items:center;gap:6px;margin-bottom:3px;}',
      '.pvc-hex{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:15px;font-weight:700;color:#0f172a;letter-spacing:.02em;}',
      '.pvc-copy{font-size:11px;padding:3px 8px;border:1px solid #cbd5e1;border-radius:6px;background:#f8fafc;cursor:pointer;color:#334155;}',
      '.pvc-copy:hover{background:#eef2ff;border-color:#a5b4fc;}',
      '.pvc-rgb,.pvc-hsl{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;color:#475569;line-height:1.6;white-space:nowrap;}',
      '.pvc-hexinputrow{display:flex;gap:6px;margin-top:10px;}',
      '.pvc-hexinput{flex:1;min-width:0;padding:6px 9px;border:1px solid #e2e8f0;border-radius:8px;font-size:13px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#334155;outline:none;}',
      '.pvc-hexinput:focus{border-color:#4e93c9;box-shadow:0 0 0 2px rgba(78,147,201,.2);}',
      '.pvc-add{padding:6px 12px;background:#4e93c9;color:#fff;border:none;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap;}',
      '.pvc-add:hover{background:#3c77a8;}',
      '.pvc-copied{background:#dcfce7!important;border-color:#86efac!important;color:#166534!important;}',
      '@media (max-width:340px){.pvc-values{flex-direction:column;align-items:flex-start;}}',
      '@media (prefers-reduced-motion:reduce){.pvc-cell{transition:none;}}'
    ].join('\n');
    document.head.appendChild(st);
  }

  /* ---------------- component ---------------- */
  function init(container, options) {
    ensureStyles();
    container.classList.add('pvc');
    container.innerHTML = '';

    var opts = options || {};
    var initial = normalizeHex(opts.value) || '#93CAED';
    var initHsl = hexToHsl(initial);

    var palette = buildPalette();
    var state = { h: initHsl.h, s: Math.max(initHsl.s, 30), l: initHsl.l };

    var top = document.createElement('div');
    top.className = 'pvc-top';
    top.textContent = 'All colors';

    var grid = document.createElement('div');
    grid.className = 'pvc-grid';

    var selected = null;
    function clearSelection() {
      if (selected) { selected.el.classList.remove('sel'); }
    }
    function selectSwatch(w) {
      clearSelection();
      selected = w;
      w.el.classList.add('sel');
    }

    palette.forEach(function (w) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pvc-cell';
      btn.style.backgroundColor = w.hex;
      btn.title = w.hex.toUpperCase();
      btn.setAttribute('aria-label', 'Color ' + w.hex.toUpperCase());
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        state.h = w.h; state.s = w.s; state.l = w.l;
        slider.value = state.l;
        updateTrack();
        selectSwatch(w);
        refresh();
        if (opts.onChangeLive) opts.onChangeLive(currentHex());
        if (opts.onChangeCommit) opts.onChangeCommit(currentHex());
      });
      grid.appendChild(btn);
      w.el = btn;
    });

    // brightness slider (0 = black .. 100 = white)
    var sliderWrap = document.createElement('div');
    sliderWrap.className = 'pvc-slider-wrap';
    var shadeLbl = document.createElement('span');
    shadeLbl.className = 'pvc-slider-label';
    shadeLbl.textContent = 'Dark';
    var slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0'; slider.max = '100'; slider.step = '1';
    slider.value = state.l;
    slider.className = 'pvc-slider';
    slider.setAttribute('aria-label', 'Brightness');
    var tintLbl = document.createElement('span');
    tintLbl.className = 'pvc-slider-label';
    tintLbl.textContent = 'Bright';
    sliderWrap.appendChild(shadeLbl);
    sliderWrap.appendChild(slider);
    sliderWrap.appendChild(tintLbl);

    function updateTrack() {
      slider.style.background = 'linear-gradient(to right, hsl(' + state.h + ', ' + state.s + '%, 0%), hsl(' + state.h + ', ' + state.s + '%, 50%), hsl(' + state.h + ', ' + state.s + '%, 100%))';
    }

    slider.addEventListener('input', function () {
      state.l = parseInt(slider.value, 10);
      refresh();
      if (opts.onChangeLive) opts.onChangeLive(currentHex());
    });
    slider.addEventListener('change', function () {
      if (opts.onChangeCommit) opts.onChangeCommit(currentHex());
    });

    // live values
    var swatch = document.createElement('div');
    swatch.className = 'pvc-swatch';

    var hexEl = document.createElement('span');
    hexEl.className = 'pvc-hex';
    var copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'pvc-copy';
    copyBtn.textContent = 'Copy';
    copyBtn.title = 'Click to copy HEX';
    copyBtn.addEventListener('click', function () {
      copyText(currentHex());
    });
    var hexRow = document.createElement('div');
    hexRow.className = 'pvc-hexrow';
    hexRow.appendChild(hexEl);
    hexRow.appendChild(copyBtn);

    var rgbEl = document.createElement('div');
    rgbEl.className = 'pvc-rgb';
    var hslEl = document.createElement('div');
    hslEl.className = 'pvc-hsl';

    var data = document.createElement('div');
    data.className = 'pvc-data';
    data.appendChild(hexRow);
    data.appendChild(rgbEl);
    data.appendChild(hslEl);

    var values = document.createElement('div');
    values.className = 'pvc-values';
    values.appendChild(swatch);
    values.appendChild(data);

    function currentHex() { return hslToHex(state.h, state.s, state.l); }
    function refresh() {
      var hex = currentHex();
      var rgb = hslToRgb(state.h, state.s, state.l);
      swatch.style.backgroundColor = hex;
      hexEl.textContent = hex.toUpperCase();
      rgbEl.textContent = 'rgb(' + rgb[0] + ', ' + rgb[1] + ', ' + rgb[2] + ')';
      hslEl.textContent = 'hsl(' + state.h + ', ' + state.s + '%, ' + state.l + '%)';
      updateTrack();
    }

    // hex input + Add (like Word's custom color dialog)
    var hexRow2 = document.createElement('div');
    hexRow2.className = 'pvc-hexinputrow';
    var hexIn = document.createElement('input');
    hexIn.className = 'pvc-hexinput';
    hexIn.placeholder = '#RRGGBB';
    hexIn.spellcheck = false;
    var addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'pvc-add';
    addBtn.textContent = 'Add';
    hexRow2.appendChild(hexIn);
    hexRow2.appendChild(addBtn);

    function applyHexInput() {
      var hex = normalizeHex(hexIn.value);
      if (!hex) { hexIn.style.borderColor = '#ef4444'; hexIn.focus(); return; }
      hexIn.style.borderColor = '';
      var h = hexToHsl(hex);
      state.h = h.h; state.s = Math.max(h.s, 30); state.l = h.l;
      slider.value = state.l;
      selectSwatch(nearestSwatch(palette, state.h, state.s));
      refresh();
      if (opts.onChangeLive) opts.onChangeLive(currentHex());
      if (opts.onChangeCommit) opts.onChangeCommit(currentHex());
    }
    addBtn.addEventListener('click', function (e) { e.stopPropagation(); applyHexInput(); });
    hexIn.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.stopPropagation(); applyHexInput(); }
    });
    hexIn.addEventListener('input', function () { hexIn.style.borderColor = ''; });

    function copyText(text) {
      function done() {
        copyBtn.textContent = 'Copied!';
        copyBtn.classList.add('pvc-copied');
        setTimeout(function () {
          copyBtn.textContent = 'Copy';
          copyBtn.classList.remove('pvc-copied');
        }, 1400);
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done(); });
      } else { fallbackCopy(text); done(); }
    }
    function fallbackCopy(text) {
      var ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch (e) {}
      document.body.removeChild(ta);
    }

    container.appendChild(top);
    container.appendChild(grid);
    container.appendChild(sliderWrap);
    container.appendChild(values);
    container.appendChild(hexRow2);

    // initial state
    selectSwatch(nearestSwatch(palette, state.h, state.s));
    refresh();

    return {
      getHex: currentHex,
      setValue: function (hex) {
        hex = normalizeHex(hex); if (!hex) return;
        var h = hexToHsl(hex);
        state.h = h.h; state.s = Math.max(h.s, 30); state.l = h.l;
        slider.value = state.l;
        selectSwatch(nearestSwatch(palette, state.h, state.s));
        refresh();
      }
    };
  }

  global.PetVetColorPicker = { init: init };
})(window);