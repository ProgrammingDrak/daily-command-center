'use strict';
const crypto = require('node:crypto');
const express = require('express');
const ORIGIN = 'https://daily-command-center-production-1d04.up.railway.app';
const PACKAGE = 'com.drake.dccalarm';
const CALLBACK = '/auth/android/callback';
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const CERTIFICATE = /^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/;
const digest = value => crypto.createHash('sha256').update(value).digest('base64url');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const escape = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

/** Session handoff after EXISTING DCC/Clerk browser authentication, not a provider/client. */
module.exports = function createAndroidAuth({ enabled = false, certificateFingerprint = '', clock = Date.now, limit = 1000, onSession = async () => {} } = {}) {
  const certificate = certificateFingerprint.trim().toUpperCase();
  const configured = enabled === true && CERTIFICATE.test(certificate);
  const router = express.Router();
  // Short-lived, single-process authority. Restart/multiple replicas fail closed; no auth DB migration.
  const flows = new Map(), codes = new Map();
  const fresh = () => {
    const now = clock();
    for (const map of [flows,codes]) for (const [key,value] of map) if (value.expires <= now) map.delete(key);
  };
  const available = (req,res,next) => {
    res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'});
    if (!configured) return res.status(503).json({error:'Android browser sign-in is not released. Signing/verified App Links and server configuration are required.'});
    if (Number(req.get('content-length') || 0) > 2048 || (req.rawBody && req.rawBody.length > 2048)) return res.status(413).json({error:'Android sign-in request is too large'});
    fresh(); next();
  };
  router.get('/api/auth/android/config', (req,res) => {
    res.set('Cache-Control','no-store').json({version:1,enabled:configured,packageName:PACKAGE});
  });
  router.get('/.well-known/assetlinks.json', (req,res) => {
    res.set('Cache-Control','public, max-age=300').json(configured ? [{relation:['delegate_permission/common.handle_all_urls'],target:{namespace:'android_app',package_name:PACKAGE,sha256_cert_fingerprints:[certificate]}}] : []);
  });
  router.get('/auth/android/authorize', available, (req,res) => {
    const {state,challenge} = req.query;
    if (!TOKEN.test(state || '') || !TOKEN.test(challenge || '') || typeof state !== 'string' || typeof challenge !== 'string' || Object.keys(req.query).some(k => !['state','challenge'].includes(k))) return res.status(400).send('Invalid Android sign-in request.');
    const continuation = '/auth/android/authorize?' + new URLSearchParams({state,challenge});
    if (!req.session?.userId) return res.redirect(303,'/login?' + new URLSearchParams({next:continuation}));
    if (flows.size >= limit) return res.status(429).send('Too many sign-in attempts. Retry later.');
    const nonce = crypto.randomBytes(32).toString('base64url');
    flows.set(nonce,{state,challenge,sessionId:req.sessionID,userId:req.session.userId,username:req.session.username,workspaceId:req.session.workspaceId,expires:clock()+300000});
    res.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; form-action 'self'; style-src 'unsafe-inline'; base-uri 'none'");
    res.type('html').send('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Confirm DCC Android sign-in</title><style>body{font:18px system-ui;max-width:36rem;padding:24px;margin:0 auto;color:#172033}button,a{display:inline-block;min-height:48px;padding:12px;box-sizing:border-box}strong{overflow-wrap:anywhere}</style><h1>Sign in to DCC on this phone?</h1><p>Continue as <strong>' + escape(req.session.username || 'your signed-in DCC account') + '</strong>.</p><p>This shares your DCC session with the Android dashboard. Device alarms stay local and unchanged. Only continue if you started sign-in in the DCC Android app.</p><form action="/auth/android/approve" method="post"><input type="hidden" name="nonce" value="' + nonce + '"><button type="submit">Continue to DCC Android</button></form><p><a href="/">Cancel — stay in browser</a></p></html>');
  });
  router.post('/auth/android/approve', express.urlencoded({extended:false,limit:'2kb'}), available, (req,res) => {
    if (!req.is('application/x-www-form-urlencoded') || req.get('origin') !== ORIGIN || !req.session?.userId) return res.status(403).send('Sign-in confirmation refused.');
    const nonce = req.body?.nonce;
    const flow = typeof nonce === 'string' && TOKEN.test(nonce) ? flows.get(nonce) : null;
    if (!flow || flow.sessionId !== req.sessionID || flow.userId !== req.session.userId || flow.workspaceId !== req.session.workspaceId) return res.status(403).send('Sign-in expired or the browser account changed. Start again from DCC Android.');
    if (codes.size >= limit) return res.status(429).send('Too many sign-in attempts. Retry later.');
    flows.delete(nonce);
    const code = crypto.randomBytes(32).toString('base64url');
    codes.set(digest(code),{...flow,expires:clock()+120000});
    res.redirect(303,ORIGIN+CALLBACK+'?'+new URLSearchParams({code,state:flow.state}));
  });
  router.get(CALLBACK, (req,res) => {
    // No credentials/parameters reflected. The signed app must capture the verified HTTPS link.
    res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'; base-uri 'none'"}).status(409).type('text').send('DCC Android did not receive the verified return link. No session was transferred. Return to the app and restart sign-in after App Links are verified.');
  });
  router.post('/api/auth/android/exchange', express.json({limit:'2kb'}), available, async (req,res) => {
    if (!req.is('application/json') || (req.get('origin') && req.get('origin') !== ORIGIN)) return res.status(403).json({error:'Invalid exchange origin or content type'});
    const {code,state,verifier} = req.body || {};
    if (![code,state,verifier].every(v => typeof v === 'string' && TOKEN.test(v)) || Object.keys(req.body).some(k => !['code','state','verifier'].includes(k))) return res.status(400).json({error:'Invalid Android exchange'});
    const key = digest(code), grant = codes.get(key);
    if (!grant || !equal(state,grant.state) || !equal(digest(verifier),grant.challenge)) return res.status(401).json({error:'Invalid or expired Android sign-in'});
    // Burn atomically BEFORE async session work. Concurrent replay/session failure cannot reuse it.
    codes.delete(key);
    try {
      await new Promise((resolve,reject) => req.session.regenerate(error => error ? reject(error) : resolve()));
      req.session.userId = grant.userId; req.session.username = grant.username; req.session.workspaceId = grant.workspaceId;
      await onSession(req,{userId:grant.userId,username:grant.username,workspaceId:grant.workspaceId});
      await new Promise((resolve,reject) => req.session.save(error => error ? reject(error) : resolve()));
      res.json({ok:true}); // DCC's existing secure HttpOnly cookie is the only session credential.
    } catch {
      req.session?.destroy(() => {});
      res.status(503).json({error:'Could not establish DCC session; start sign-in again'});
    }
  });
  return router;
};
module.exports.ORIGIN = ORIGIN;
