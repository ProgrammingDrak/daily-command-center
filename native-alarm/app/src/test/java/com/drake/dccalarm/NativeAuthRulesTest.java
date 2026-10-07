package com.drake.dccalarm;

import static org.junit.Assert.*;

import org.junit.Test;

public class NativeAuthRulesTest {
  @Test
  public void pkceUsesCryptographicUrlSafeTokensAndS256() {
    String verifier = NativeAuthRules.token();
    assertTrue(NativeAuthRules.validToken(verifier));
    assertNotEquals(verifier, NativeAuthRules.token());
    assertTrue(NativeAuthRules.validToken(NativeAuthRules.challenge(verifier)));
    assertEquals(
        "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
        NativeAuthRules.challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"));
  }

  @Test
  public void callbackRequiresVerifiedOriginExactPathStateAndDeadline() {
    String state = NativeAuthRules.token(), code = NativeAuthRules.token();
    String uri = OriginPolicy.ORIGIN + "/auth/android/callback?code=" + code + "&state=" + state;
    assertEquals(code, NativeAuthRules.code(uri, state, true, 1000));
    assertNull(NativeAuthRules.code(uri, state, false, 1000));
    assertNull(NativeAuthRules.code(uri, NativeAuthRules.token(), true, 1000));
    assertNull(NativeAuthRules.code(uri, state, true, 300001));
    assertNull(NativeAuthRules.code(uri, state, true, -1));
    assertNull(NativeAuthRules.code(uri, null, true, 1));
    assertNull(
        NativeAuthRules.code(uri.replace("/auth/android/callback", "/login"), state, true, 1));
    assertNull(
        NativeAuthRules.code(
            uri.replace(OriginPolicy.ORIGIN, "https://evil.test"), state, true, 1));
  }

  @Test
  public void duplicateExtraFragmentMalformedOrCredentialCallbacksFailClosed() {
    String state = NativeAuthRules.token(), code = NativeAuthRules.token();
    String uri = OriginPolicy.ORIGIN + "/auth/android/callback?code=" + code + "&state=" + state;
    for (String value :
        new String[] {
          uri + "&state=" + state,
          uri + "&cookie=x",
          uri + "#fragment",
          uri + "&",
          uri.replace("https://", "https://user@"),
          "intent://callback",
          uri.replace(code, "short")
        }) assertNull(value, NativeAuthRules.code(value, state, true, 1));
  }

  @Test
  public void onlyExactSecureHttpOnlyRootSessionCookieCanBeInstalledOrRemoved() {
    String cookie = "dcc_session=synthetic; Path=/; HttpOnly; Secure; SameSite=Lax";
    assertTrue(NativeAuthRules.sessionCookie(cookie));
    for (String value :
        new String[] {
          "other=synthetic; Path=/; HttpOnly; Secure",
          cookie.replace("HttpOnly", "HttpOnlyFoo"),
          cookie.replace("Secure", "SecureFoo"),
          cookie.replace("Path=/", "Path=/other"),
          cookie + "; Domain=example.com",
          cookie + "\nother=x",
          null
        }) assertFalse(NativeAuthRules.sessionCookie(value));
    assertTrue(NativeAuthRules.currentCookieMatches("other=x; dcc_session=synthetic", cookie));
    assertFalse(NativeAuthRules.currentCookieMatches("dcc_session=newer", cookie));
  }
}
