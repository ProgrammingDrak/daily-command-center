package com.drake.dccalarm;

import java.net.URI;

/** No caller-controlled hosts, suffix matches, credentials or cleartext. */
final class OriginPolicy {
  static final String ORIGIN = "https://daily-command-center-production-1d04.up.railway.app";

  static boolean trusted(String value) {
    try {
      URI u = new URI(value);
      return "https".equalsIgnoreCase(u.getScheme())
          && u.getRawUserInfo() == null
          && "daily-command-center-production-1d04.up.railway.app".equalsIgnoreCase(u.getHost())
          && (u.getPort() == -1 || u.getPort() == 443);
    } catch (Exception e) {
      return false;
    }
  }

  static boolean external(String value) {
    try {
      URI u = new URI(value);
      return "https".equalsIgnoreCase(u.getScheme())
          && u.getHost() != null
          && u.getRawUserInfo() == null;
    } catch (Exception e) {
      return false;
    }
  }

  static boolean bridgeAllowed(String origin, boolean mainFrame, String currentUrl) {
    return mainFrame && trusted(origin) && trusted(currentUrl);
  }
}
