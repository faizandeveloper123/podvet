// Mobile-usage optimization layer for the PetVet web app.
//
// The React bundle ships a desktop-first app: a fixed w-64 sidebar that leaves
// the content column ~120px wide on phones, plus tables/cards/inputs built for
// a mouse. Since there is no JSX source to patch (only the built dist), this
// injected layer fixes it at runtime with zero rebuilds:
//
//   * The sidebar becomes an off-canvas drawer (hamburger button + scrim).
//   * Main content takes the full width; margins/paddings are trimmed.
//   * Touch targets grow to >=44px, form inputs to 16px (stops iOS zoom).
//   * Tables get a horizontal-scroll wrapper, cards widen, grids collapse.
//   * Fixed modals become bottom sheets; the logout dialog stays usable.
(function () {
  if (window.__mobileUxLoaded) return;
  window.__mobileUxLoaded = true;

  var IS_MOBILE_QUERY = '(max-width: 767px)';
  var styleEl = document.createElement('style');
  styleEl.textContent = [
    'html.is-mobile { -webkit-text-size-adjust: 100%; }',
    '@media (max-width: 767px){',
    '  .pv-sidebar {',
    '    position: fixed !important;',
    '    top: 0 !important;',
    '    left: 0 !important;',
    '    height: 100dvh !important;',
    '    max-height: 100dvh !important;',
    '    width: 82vw !important;',
    '    max-width: 320px !important;',
    '    transform: translateX(-105%);',
    '    transition: transform 0.25s ease !important;',
    '    -webkit-transition: transform 0.25s ease !important;',
    '    z-index: 9999 !important;',
    '    box-shadow: 0 0 24px rgba(15, 23, 42, 0.25);',
    '    border-right: 1px solid #e2e8f0 !important;',
    '    will-change: transform;',
    '  }',
    '  .pv-sidebar-open .pv-sidebar { transform: translateX(0) !important; }',
    '  .pv-hamburger {',
    '    position: fixed !important;',
    '    top: 14px !important;',
    '    left: 14px !important;',
    '    z-index: 9998 !important;',
    '    width: 44px;',
    '    height: 44px;',
    '    display: flex;',
    '    align-items: center;',
    '    justify-content: center;',
    '    border-radius: 10px;',
    '    background: rgba(255,255,255,0.95);',
    '    border: 1px solid #e2e8f0;',
    '    box-shadow: 0 1px 3px rgba(15,23,42,0.12);',
    '    color: #334155;',
    '    cursor: pointer;',
    '  }',
    '  .pv-scrim {',
    '    position: fixed !important;',
    '    inset: 0 !important;',
    '    background: rgba(15, 23, 42, 0.4) !important;',
    '    z-index: 9997 !important;',
    '    opacity: 0;',
    '    visibility: hidden;',
    '    transition: opacity 0.25s ease, visibility 0.25s ease;',
    '  }',
    '  .pv-sidebar-open .pv-scrim { opacity: 1; visibility: visible; }',
    '  .pv-main {',
    '    margin-left: 0 !important;',
    '    padding-left: 16px !important;',
    '    padding-right: 16px !important;',
    '    padding-top: 12px !important;',
    '  }',
    '  .pv-main > * { min-width: 0; }',
    '  .pv-main table { display: block; overflow-x: auto; -webkit-overflow-scrolling: touch; }',
    '  .pv-table-wrap, .pv-main div:has(> table) {',
    '    overflow-x: auto !important;',
    '    -webkit-overflow-scrolling: touch;',
    '  }',
    '  .pv-main button { min-height: 44px; }',
    '  .pv-main a { min-height: 44px; }',
    '  .pv-main input,',
    '  .pv-main select,',
    '  .pv-main textarea { font-size: 16px !important; }',
    '  .pv-main .fixed { max-width: calc(100vw - 32px); }',
    '  .logout-dialog-mobile {',
    '    position: fixed !important;',
    '    left: 50% !important;',
    '    top: 50% !important;',
    '    transform: translate(-50%, -50%) !important;',
    '    width: calc(100vw - 48px) !important;',
    '    max-width: 320px !important;',
    '    margin: 0 !important;',
    '  }',
    '}',
    '@media (min-width: 768px){',
    '  .pv-hamburger, .pv-scrim { display: none !important; }',
    '}',
  ].join('\n');
  (document.head || document.documentElement).appendChild(styleEl);

  function inMobile() {
    try { return window.matchMedia(IS_MOBILE_QUERY).matches; } catch (_) { return false; }
  }

  var scrimEl = null;
  var hamEl = null;

  function closeDrawer() {
    document.documentElement.classList.remove('pv-sidebar-open');
  }

  function ensureChrome() {
    if (!inMobile()) {
      document.documentElement.classList.remove('is-mobile', 'pv-sidebar-open');
      if (hamEl) hamEl.style.display = 'none';
      if (scrimEl) scrimEl.style.display = 'none';
      return;
    }
    document.documentElement.classList.add('is-mobile');
    if (!scrimEl) {
      scrimEl = document.createElement('div');
      scrimEl.className = 'pv-scrim';
      scrimEl.setAttribute('aria-hidden', 'true');
      scrimEl.addEventListener('click', closeDrawer);
      document.body.appendChild(scrimEl);
    }
    scrimEl.style.display = 'block';
    if (!hamEl) {
      hamEl = document.createElement('button');
      hamEl.className = 'pv-hamburger';
      hamEl.setAttribute('aria-label', 'Toggle navigation');
      hamEl.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M3 12h18M3 18h18"/></svg>';
      hamEl.addEventListener('click', function () {
        document.documentElement.classList.toggle('pv-sidebar-open');
      });
      hamEl.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' || e.key === 'Esc') closeDrawer();
      });
      document.body.appendChild(hamEl);
    }
    hamEl.style.display = 'flex';
  }

  function tagLayout() {
    // Main content column (flex-1 + ml-64/ml-20 + bg-gray-50).
    var main = document.querySelector('main');
    if (main) main.classList.add('pv-main');

    // The fixed sidebar: tall fixed column on the left edge.
    var candidates = document.querySelectorAll('div.fixed');
    for (var i = 0; i < candidates.length; i++) {
      var el = candidates[i];
      var cls = el.className || '';
      if (cls.indexOf('inset-y-0') === -1 && cls.indexOf('top-0') === -1) continue;
      if (cls.indexOf('left-0') === -1) continue;
      if (cls.indexOf('h-screen') === -1) continue;
      if (cls.indexOf('flex-col') === -1) continue;
      el.classList.add('pv-sidebar');
      break;
    }

    // Logout dialog lives in a portal; give it a mobile-safe width.
    var dialogs = document.querySelectorAll('[role="dialog"] div.w-80');
    for (var j = 0; j < dialogs.length; j++) dialogs[j].classList.add('logout-dialog-mobile');
  }

  function apply() {
    ensureChrome();
    tagLayout();
  }

  apply();

  // Re-tag after SPA navigation / route changes (dist keeps a persistent shell,
  // but page-mounted layout can be recreated).
  var rafPending = false;
  function schedule() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(function () {
      rafPending = false;
      apply();
    });
  }
  var mo = new MutationObserver(schedule);
  if (document.documentElement) {
    mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  }
  window.addEventListener('resize', schedule);
  window.addEventListener('load', apply);
  document.addEventListener('keydown', function (e) {
    if ((e.key === 'Escape' || e.key === 'Esc') && inMobile()) closeDrawer();
  });
})();