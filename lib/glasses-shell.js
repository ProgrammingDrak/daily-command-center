const fs = require('node:fs');
const path = require('node:path');

// Keep the canonical task engine and action owners. Only the initial presentation
// differs; desktop launches still use the ordinary document.
module.exports = function glassesShell(projectDir) {
  const html = fs.readFileSync(path.join(projectDir, 'index.html'), 'utf8')
    .replace('<html lang="en">', '<html lang="en" class="glasses-starting">')
    .replace('<head>', `<head>
<style>
html.glasses-starting { background: #0d1722; color-scheme: dark; }
html.glasses-starting body { margin: 0; background: #0d1722 !important; }
html.glasses-starting body > :not(#glasses-startup):not(script):not(style):not(link) { display: none !important; }
#glasses-startup { box-sizing: border-box; min-height: 100dvh; max-width: 640px; margin: auto; padding: 24px; display: flex; flex-direction: column; justify-content: center; gap: 20px; background: #0d1722; color: #eef5ff; font: 18px/1.5 system-ui, sans-serif; }
#glasses-startup h1 { margin: 0; color: #65d9a4; font-size: 24px; }
#glasses-startup p { margin: 0; }
#glasses-startup a { color: #84c4ff; display: inline-flex; align-items: center; min-height: 44px; }
</style>`)
    .replace('<body>', `<body>
<main id="glasses-startup" aria-label="DCC Glasses">
  <h1>DCC Glasses</h1>
  <p role="status">Loading your tasks…</p>
  <noscript><p>Enable JavaScript to load your tasks.</p></noscript>
  <a href="/glasses">Reload glasses</a>
  <a href="/">Full app</a>
</main>`);
  return function serveGlassesShell(req, res, next) {
    if (req.query.device !== 'glasses') return next();
    res.setHeader('Cache-Control', 'private, no-store');
    res.type('html').send(html);
  };
};
