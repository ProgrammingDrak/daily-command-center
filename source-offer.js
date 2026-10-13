// SPDX-License-Identifier: AGPL-3.0-only
const fs = require('node:fs');
const path = require('node:path');
const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function sourceOffer({repository, isPublic}, env = process.env) {
  const revision = env.SOURCE_REVISION || env.RAILWAY_GIT_COMMIT_SHA || '';
  const validRevision = /^[a-f0-9]{40}$/.test(revision);
  let archive = env.SOURCE_ARCHIVE_URL || (isPublic && validRevision ? `https://github.com/ProgrammingDrak/${repository}/archive/${revision}.tar.gz` : '');
  let validArchive = false;
  try {
    const url = new URL(archive);
    validArchive = validRevision && url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.pathname.split('/').some(part => part === revision || part === `${revision}.tar.gz` || part === `${revision}.zip`);
  } catch {}
  if (!validArchive && env.NODE_ENV === 'production') throw new Error('Source publication gate: configure SOURCE_REVISION and an accessible HTTPS SOURCE_ARCHIVE_URL containing that exact commit in its path.');
  const offer = validArchive
    ? `<p><a href="${escape(archive)}">Download corresponding source for this version</a></p><p>Revision: <code>${escape(revision)}</code></p><p>The archive includes installation/build instructions and dependency notices. The source must be available at no charge to every user of this version.</p>`
    : '<p>Source access for this local preview is not configured. This preview is not a compliant hosted source offer. Publication is required before deployment.</p>';
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Source and license</title><main><h1>Source and license</h1><p>${escape(repository)}: Copyright (C) 2026 Drake Shadwell.</p><p>This software is licensed under GNU AGPL version 3 only, without warranty. Third-party components keep their own licenses.</p>${offer}<p><a href="/license">Read the license</a></p></main></html>`;
}

function registerSourceOffer(app, options) {
  const html = sourceOffer(options);
  app.get('/source', (_req, res) => res.set('Cache-Control', 'no-store').type('html').send(html));
  app.get('/license', (_req, res) => res.type('text/plain').send(fs.readFileSync(path.join(__dirname, 'LICENSE'), 'utf8')));
}
module.exports = {sourceOffer, registerSourceOffer};
