// Generates the browser preload served at /web-preload.js. The real Electron
// preload (preload.js) is kept verbatim; we wrap its contextBridge call with a
// browser shim so window.electronAPI.* calls become HTTP posts to /_rpc/*.
const fs = require('fs');
const path = require('path');

const BUFFER_MARKER = '__pdfBuffer';
const DATE_MARKER = '__date';

function serializeRpcResult(value) {
  if (Buffer.isBuffer(value)) return { [BUFFER_MARKER]: value.toString('base64') };
  if (value instanceof Date) return { [DATE_MARKER]: value.toISOString() };
  if (Array.isArray(value)) return value.map(serializeRpcResult);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = serializeRpcResult(value[k]);
    return out;
  }
  return value;
}

function generateWebPreload() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');

  const bootstrap = `
(function () {
  var __listenerMap = {};
  var __es = null;
  function __revive(value) {
    if (Array.isArray(value)) return value.map(__revive);
    if (value && typeof value === 'object') {
      if (typeof value.__pdfBuffer === 'string') {
        try {
          var bin = atob(value.__pdfBuffer);
          var bytes = new Uint8Array(bin.length);
          for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          return bytes;
        } catch (_) { return value; }
      }
      if (typeof value.__date === 'string') {
        return new Date(value.__date);
      }
      for (var k in value) value[k] = __revive(value[k]);
    }
    return value;
  }
  function __wire() {
    if (__es) return;
    __es = new EventSource('/events');
    __es.onmessage = function () {};
  }
  function __dispatch(channel, payload) {
    (__listenerMap[channel] || []).slice().forEach(function (fn) { fn(null, payload); });
  }
  var contextBridge = {
    exposeInMainWorld: function (name, obj) { window[name] = obj; if (window.__electronApiReady) window.__electronApiReady(name, obj); }
  };
  var ipcRenderer = {
    invoke: function (channel) {
      var args = Array.prototype.slice.call(arguments, 1)
        .map(function (a) { return a === undefined ? null : a; });
      if (channel === 'open-file-dialog' || channel === 'scan-products-csv' ||
          channel === 'pick-logo-file-select') {
        return __pickAndUpload(channel).then(function (go) {
          if (!go) return channel === 'open-file-dialog'
            ? { success: false, message: 'No file selected' }
            : { success: false, canceled: true };
          return __invokeRpc(channel, args, go.path);
        });
      }
      return __invokeRpc(channel, args, null);
    },
    on: function (channel, listener) {
      __wire();
      if (!__listenerMap[channel]) __listenerMap[channel] = [];
      __listenerMap[channel].push(listener);
      __es.addEventListener(channel, function (e) {
        var payload = null;
        try { payload = JSON.parse(e.data); } catch (_) {}
        (__listenerMap[channel] || []).slice().forEach(function (fn) { fn(null, payload); });
      });
    },
    removeListener: function (channel) {
      __listenerMap[channel] = [];
    }
  };
  var __SESS_KEY = 'podvet_session';
  function __loadSession() {
    try { return JSON.parse(localStorage.getItem(__SESS_KEY) || 'null') || null; } catch (_) { return null; }
  }
  function __saveSession(user, tokens) {
    try { localStorage.setItem(__SESS_KEY, JSON.stringify({ user: user, tokens: tokens })); } catch (_) {}
  }
  function __clearSession() {
    try { localStorage.removeItem(__SESS_KEY); } catch (_) {}
  }
  // After login/switch-clinic/signup, capture the fresh user + tokens so the
  // session survives server restarts (Render wipes ~/.podvet on deploy; the
  // browser keeps the session and re-injects it on every RPC).
  function __captureSession(channel, result) {
    if (channel === 'logout') return __clearSession();
    // One login page for everyone: a platform-staff login lands here, so stash
    // the Super Admin token and hand the browser over to /super-admin.
    if (channel === 'login' && result && result.superAdmin && result.token) {
      try { localStorage.setItem('podvet_super_token', result.token); } catch (_) {}
      location.replace('/super-admin');
      return;
    }
    if (channel === 'login' || channel === 'switch-clinic' || channel === 'clinic-signup') {
      if (result && result.user) {
        fetch('/_rpc/__get-tokens', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ args: [] })
        }).then(function (r) { return r.json(); }).then(function (j) {
          if (j.ok && j.result && j.result.accessToken) {
            __saveSession(result.user, { accessToken: j.result.accessToken, refreshToken: j.result.refreshToken });
          }
        }).catch(function () {});
      }
    }
  }
  // Render free tier sleeps after ~15 min idle; the wake-up cold boot can take
  // up to a minute. Retry transient network failures (not RPC errors) so a
  // normal cold start never surfaces as a generic "Failed to load..." toast.
  var __RETRY_DELAYS = [1500, 3000, 6000, 12000, 24000];
  function __fetchWithRetry(url, options, attempt) {
    attempt = attempt || 0;
    return fetch(url, options).then(function (r) {
      return r.json();
    }).catch(function () {
      if (attempt >= __RETRY_DELAYS.length) {
        throw new Error('Could not reach the server. Please try again.');
      }
      return new Promise(function (resolve) {
        setTimeout(function () { resolve(__fetchWithRetry(url, options, attempt + 1)); }, __RETRY_DELAYS[attempt]);
      });
    });
  }
  function __invokeRpc(channel, args, dialogFilePath) {
    var body = { args: args, dialogFilePath: dialogFilePath };
    var sess = __loadSession();
    if (sess && sess.tokens && sess.tokens.accessToken) body.session = sess;
    return __fetchWithRetry('/_rpc/' + encodeURIComponent(channel), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (json) {
      if (json.ok) {
        __captureSession(channel, json.result);
        return __revive(json.result);
      }
      var err = new Error((json.error && json.error.message) || 'Request failed');
      err.code = (json.error && json.error.code) || undefined;
      throw err;
    });
  }
  function __pickAndUpload(channel) {
    return new Promise(function (resolve) {
      if (!window.__fileInput) {
        window.__fileInput = document.createElement('input');
        window.__fileInput.type = 'file';
        window.__fileInput.style.display = 'none';
        document.body.appendChild(window.__fileInput);
      }
      var input = window.__fileInput;
      var accepts = channel === 'scan-products-csv' ? '.csv'
        : channel === 'pick-logo-file-select' ? '.png,.jpg,.jpeg,.webp'
        : '.json,.xlsx,.xls';
      input.accept = accepts;
      var done = false;
      input.onchange = function () {
        if (done) return; done = true;
        var file = input.files && input.files[0];
        if (!file) return resolve(null);
        fetch('/web-upload', { method: 'POST', headers: { 'X-Filename': encodeURIComponent(file.name) }, body: file })
          .then(function (r) { return r.json(); })
          .then(function (j) { return j.ok ? resolve({ path: j.path, name: j.fileName }) : resolve(null); })
          .catch(function () { resolve(null); });
      };
      input.value = '';
      input.click();
    });
  }
  var invoke = function (channel) {
    var args = Array.prototype.slice.call(arguments, 1)
      .map(function (a) { return a === undefined ? null : a; });
    return ipcRenderer.invoke.apply(null, [channel].concat(args));
  };
`;

  const marker = 'contextBridge.exposeInMainWorld(';
  const idx = src.indexOf(marker);
  if (idx === -1) throw new Error('Could not locate exposeInMainWorld in preload.js');
  const body = src.slice(idx);

  const extra = `
  window.electronAPI.restartAppToUpdate = function () { return Promise.resolve({ success: true }); };
  window.electronAPI.openExternalLink = function (url) { window.open(url, '_blank'); return Promise.resolve(); };
  window.electronAPI.openWhatsApp = function (url) { window.open(url, '_blank'); return Promise.resolve(); };
  window.electronAPI.printPdfFile = function (pdfPath) {
    if (pdfPath) window.open('/serve-file?path=' + encodeURIComponent(pdfPath) + '&inline=1', '_blank');
    return Promise.resolve({ success: true });
  };
  window.electronAPI.printPdfBuffer = function (payload) {
    try {
      var d = (payload && payload.data) || payload;
      var bytes = typeof d === 'string' ? atob(d) : null;
      if (payload && payload.data && typeof payload.data === 'object' && payload.data.data) {
        bytes = payload.data.data.map(function (b) { return String.fromCharCode(b); }).join('');
      }
      if (bytes) {
        var blob = new Blob([Uint8Array.from(bytes, function (c) { return c.charCodeAt(0); })], { type: 'application/pdf' });
        window.open(URL.createObjectURL(blob), '_blank');
      }
    } catch (_) {}
    return Promise.resolve({ success: true });
  };

  function __rewriteFileUris(root) {
    root = root || document;
    var els = root.querySelectorAll ? root.querySelectorAll('iframe[src^="file:"], img[src^="file:"], a[href^="file:"]') : [];
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var attr = el.tagName === 'A' ? 'href' : 'src';
      var val = el.getAttribute(attr);
      if (!val || val.indexOf('file:') !== 0) continue;
      var p = val;
      if (p.indexOf('file:///') === 0) p = p.substring(7);
      else if (p.indexOf('file://') === 0) p = p.substring(7);
      else if (p.indexOf('file:/') === 0) p = p.substring(6);
      else p = p.substring(5);
      p = p.split('\\\\').join('/');
      if (/^\\/[A-Za-z]:/.test(p)) p = p.substring(1);
      el.setAttribute(attr, '/serve-file?path=' + encodeURIComponent(p) + '&inline=1');
    }
  }
  __rewriteFileUris();
  var __mut = new MutationObserver(function () { __rewriteFileUris(document); });
  __mut.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'href'] });
  window.addEventListener('load', function () { __rewriteFileUris(document); });
})();
`;

  return { source: bootstrap + '\n' + body + '\n' + extra, serializeRpcResult, reviveRpcResult };
}

function reviveRpcResult(value) {
  if (Array.isArray(value)) return value.map(reviveRpcResult);
  if (value && typeof value === 'object') {
    if (typeof value[BUFFER_MARKER] === 'string') {
      try {
        const bin = atob(value[BUFFER_MARKER]);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return bytes;
      } catch (_) { return value; }
    }
    if (typeof value[DATE_MARKER] === 'string') {
      return new Date(value[DATE_MARKER]);
    }
    for (const k of Object.keys(value)) value[k] = reviveRpcResult(value[k]);
  }
  return value;
}

module.exports = { generateWebPreload, serializeRpcResult, reviveRpcResult };