(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DccLoginReturn = factory();
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';
  // Return only a root-relative URL. Never trust next, even after provider login.
  function normalize(value) {
    if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u0020\u007f]/.test(value)) return '/';
    try {
      const url = new URL(value, 'https://dcc.invalid');
      const pathname = decodeURIComponent(url.pathname);
      if (url.origin !== 'https://dcc.invalid' || pathname.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(pathname)) return '/';
      // Avoid returning to another sign-in page (including normalized dot paths).
      if (/^\/(?:login|register)(?:\.html)?\/?$/i.test(pathname)) return '/';
      return url.pathname + url.search + url.hash;
    } catch { return '/'; }
  }
  function loginUrl(value) {
    const next = normalize(value);
    return next === '/' ? '/login' : '/login?next=' + encodeURIComponent(next);
  }
  return { normalize, loginUrl };
});
