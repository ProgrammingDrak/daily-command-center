package com.drake.dccalarm;

import static org.junit.Assert.*;

import org.junit.Test;

public class OriginPolicyTest {
  @Test
  public void exactHttpsOriginOnly() {
    assertTrue(OriginPolicy.trusted(OriginPolicy.ORIGIN + "/login?next=%2F"));
    assertTrue(OriginPolicy.trusted(OriginPolicy.ORIGIN + ":443/"));
    for (String u :
        new String[] {
          "http://daily-command-center-production-1d04.up.railway.app",
          OriginPolicy.ORIGIN + ".evil.test/",
          "https://evil.test/?next=" + OriginPolicy.ORIGIN,
          "https://user@daily-command-center-production-1d04.up.railway.app",
          OriginPolicy.ORIGIN + ":8443/",
          "file:///android_asset/a",
          "javascript:alert(1)",
          "intent://alarm",
          "https://daily-command-center-production-1d04.up.railway.app\\@evil.test"
        }) assertFalse(u, OriginPolicy.trusted(u));
  }

  @Test
  public void iframeAndNavigatedPageHaveNoBridge() {
    assertTrue(OriginPolicy.bridgeAllowed(OriginPolicy.ORIGIN, true, OriginPolicy.ORIGIN + "/"));
    assertFalse(OriginPolicy.bridgeAllowed(OriginPolicy.ORIGIN, false, OriginPolicy.ORIGIN + "/"));
    assertFalse(OriginPolicy.bridgeAllowed("https://evil.test", true, OriginPolicy.ORIGIN));
    assertFalse(OriginPolicy.bridgeAllowed(OriginPolicy.ORIGIN, true, "https://evil.test"));
  }

  @Test
  public void externalNavigationIsHttpsAndCredentialFree() {
    assertTrue(OriginPolicy.external("https://accounts.google.com/path"));
    for (String u :
        new String[] {
          "intent://x",
          "javascript:alert(1)",
          "file:///x",
          "content://x",
          "http://example.com",
          "https://a:b@example.com"
        }) assertFalse(OriginPolicy.external(u));
  }
}
