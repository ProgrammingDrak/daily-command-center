(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DccLoginHandoff = factory();
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';
  // Observe only public Clerk state. Never retain or display provider URLs,
  // tokens, account identifiers, exception messages, or request payloads.
  function create({ clerk, onFailure, inFrame = false, isForeground = () => true,
    schedule = setTimeout, unschedule = clearTimeout, delay = 8000 }) {
    let timer = null, active = false, initialId;
    function pause() {
      if (timer !== null) unschedule(timer);
      timer = null;
    }
    function cancel() { active = false; pause(); }
    function resume() {
      if (!active || timer !== null || !isForeground()) return;
      timer = schedule(() => {
        timer = null;
        if (!active || !isForeground()) return;
        active = false;
        if (clerk.user) return;
        const signIn = clerk.client?.signIn;
        // A previous attempt can remain on the resource after a failed retry.
        // Only a newly prepared attempt is evidence for this activation.
        const ready = !!signIn?.id && signIn.id !== initialId &&
          signIn.firstFactorVerification?.status === 'unverified' &&
          !!signIn.firstFactorVerification.externalVerificationRedirectURL;
        onFailure({
          code: (ready ? 'G-READY' : 'G-START') + (inFrame ? '-FRAME' : '-TOP'),
          message: ready
            ? 'Google sign-in did not continue in this window. Use email sign-in below, or try Google again.'
            : 'Google sign-in could not start. Use email sign-in below, or try again.',
        });
      }, delay);
    }
    function start() {
      cancel();
      initialId = clerk.client?.signIn?.id;
      active = true;
      resume();
    }
    return { start, cancel, pause, resume };
  }
  return { create };
});
