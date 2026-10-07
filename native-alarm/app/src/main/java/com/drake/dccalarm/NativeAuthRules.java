package com.drake.dccalarm;

import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.security.*;
import java.util.*;

/** Ephemeral PKCE/callback validation. Never accepts a caller URL, cookie, or provider token. */
final class NativeAuthRules {
  static String token() {
    byte[] bytes = new byte[32];
    new SecureRandom().nextBytes(bytes);
    return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
  }

  static String challenge(String verifier) {
    try {
      return Base64.getUrlEncoder()
          .withoutPadding()
          .encodeToString(
              MessageDigest.getInstance("SHA-256")
                  .digest(verifier.getBytes(StandardCharsets.US_ASCII)));
    } catch (NoSuchAlgorithmException e) {
      throw new IllegalStateException(e);
    }
  }

  static boolean validToken(String value) {
    return value != null && value.matches("[A-Za-z0-9_-]{43}");
  }

  static boolean sessionCookie(String value) {
    if (value == null
        || value.length() > 4096
        || value.indexOf('\n') >= 0
        || value.indexOf('\r') >= 0) return false;
    String[] parts = value.split(";");
    if (!parts[0].startsWith("dcc_session=") || parts[0].length() <= 12) return false;
    Set<String> attributes = new HashSet<>();
    for (int i = 1; i < parts.length; i++) {
      String item = parts[i].trim().toLowerCase(Locale.ROOT);
      if (item.startsWith("domain=")) return false;
      attributes.add(item);
    }
    return attributes.contains("httponly")
        && attributes.contains("secure")
        && attributes.contains("path=/");
  }

  static boolean currentCookieMatches(String current, String candidate) {
    if (current == null || !sessionCookie(candidate)) return false;
    String installed = candidate.split(";", 2)[0];
    return Arrays.stream(current.split(";")).map(String::trim).anyMatch(installed::equals);
  }

  static String code(String value, String expectedState, boolean verified, long elapsed) {
    if (!verified || !validToken(expectedState) || elapsed < 0 || elapsed > 300000) return null;
    try {
      URI uri = new URI(value);
      if (!OriginPolicy.trusted(value)
          || !"/auth/android/callback".equals(uri.getPath())
          || uri.getRawFragment() != null
          || uri.getRawQuery() == null) return null;
      Map<String, String> fields = new HashMap<>();
      for (String part : uri.getRawQuery().split("&", -1)) {
        String[] kv = part.split("=", -1);
        if (kv.length != 2) return null;
        String key = URLDecoder.decode(kv[0], StandardCharsets.UTF_8.name());
        String val = URLDecoder.decode(kv[1], StandardCharsets.UTF_8.name());
        if (fields.put(key, val) != null) return null;
      }
      if (fields.size() != 2
          || !fields.containsKey("code")
          || !fields.containsKey("state")
          || !validToken(fields.get("code"))
          || !validToken(fields.get("state"))) return null;
      return MessageDigest.isEqual(
              expectedState.getBytes(StandardCharsets.US_ASCII),
              fields.get("state").getBytes(StandardCharsets.US_ASCII))
          ? fields.get("code")
          : null;
    } catch (Exception e) {
      return null;
    }
  }
}
