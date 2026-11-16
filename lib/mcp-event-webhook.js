// MCP Events transport. Resolve once per connection and pin the validated IP;
// neither redirects nor a second, unchecked DNS lookup can reach private hosts.
const crypto = require("node:crypto");
const dns = require("node:dns").promises;
const https = require("node:https");
const net = require("node:net");
function publicAddress(address) {
  if (net.isIP(address) === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0 || b === 2)) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  // Conservatively allow only ordinary global-unicast IPv6. Reject mapped IPv4,
  // translation, documentation, Teredo, 6to4 and other special-use ranges.
  return (
    net.isIP(address) === 6 &&
    /^2[0-9a-f]{3}:/i.test(address) &&
    !(/^2001:/i.test(address) && (parseInt(address.split(":")[1] || "0", 16) < 512 || /^2001:0?db8:/i.test(address))) &&
    !/^2002:/i.test(address)
  );
}
function callbackUrl(raw) {
  if (typeof raw !== "string" || raw.length > 2048) throw new Error("Invalid callback");
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || url.hash || (url.port && url.port !== "443"))
    throw new Error("Callback requires HTTPS on port 443");
  return url;
}
function signingKey(secret) {
  if (typeof secret !== "string" || !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret))
    throw new Error("Invalid signing secret");
  const key = Buffer.from(secret.slice(6), "base64");
  if (
    key.length < 24 ||
    key.length > 64 ||
    key.toString("base64").replace(/=+$/, "") !== secret.slice(6).replace(/=+$/, "")
  )
    throw new Error("Invalid signing secret");
  return key;
}
function signature(secret, id, timestamp, body) {
  return "v1," + crypto.createHmac("sha256", signingKey(secret)).update(`${id}.${timestamp}.${body}`).digest("base64");
}
async function post(
  raw,
  body,
  headers,
  { lookup = dns.lookup, request = https.request, setTimer = setTimeout, cancelTimer = clearTimeout } = {}
) {
  const url = callbackUrl(raw),
    hostname = url.hostname.replace(/^\[|\]$/g, "");
  let timer;
  let addresses;
  try {
    addresses = net.isIP(hostname)
      ? [{ address: hostname, family: net.isIP(hostname) }]
      : await Promise.race([
          lookup(hostname, { all: true, verbatim: true }),
          new Promise((_resolve, reject) => {
            timer = setTimer(() => reject(new Error("Callback DNS timeout")), 3000);
          })
        ]);
  } finally {
    cancelTimer(timer);
  }
  if (!addresses.length || addresses.some((entry) => !publicAddress(entry.address)))
    throw new Error("Non-public callback address");
  const destination = addresses[0];
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: "POST",
        headers: { ...headers, "Content-Length": Buffer.byteLength(body) },
        family: destination.family,
        autoSelectFamily: false,
        lookup: (_host, _options, cb) => cb(null, destination.address, destination.family)
      },
      (res) => {
        let text = "",
          bytes = 0;
        res.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > 8192) res.destroy(new Error("Callback response too large"));
          else text += chunk;
        });
        res.on("error", reject);
        res.on("end", () => resolve({ status: res.statusCode, body: text }));
      }
    );
    // Covers TLS, response and total transfer time, including slow trickles.
    const timer = setTimer(() => req.destroy(new Error("Callback timeout")), 10000);
    req.on("error", reject);
    req.on("close", () => cancelTimer(timer));
    req.end(body);
  });
}
function createTransport({ send = post, now = Date.now } = {}) {
  async function signed(subscription, payload, id, previousSecret) {
    const body = JSON.stringify(payload),
      timestamp = String(Math.floor(now() / 1000));
    const sig = [subscription.secret, previousSecret]
      .filter(Boolean)
      .map((key) => signature(key, id, timestamp, body))
      .join(" ");
    return send(subscription.url, body, {
      "Content-Type": "application/json",
      "webhook-id": id,
      "webhook-timestamp": timestamp,
      "webhook-signature": sig,
      "X-MCP-Subscription-Id": subscription.id
    });
  }
  return {
    async verify(subscription) {
      const challenge = crypto.randomBytes(32).toString("base64url");
      const response = await signed(subscription, { type: "verification", challenge }, "verify_" + crypto.randomUUID());
      let echoed;
      try {
        echoed = JSON.parse(response.body).challenge;
      } catch {
        /* invalid response */
      }
      if (
        !(response.status >= 200 && response.status < 300) ||
        typeof echoed !== "string" ||
        Buffer.byteLength(echoed) !== Buffer.byteLength(challenge) ||
        !crypto.timingSafeEqual(Buffer.from(echoed), Buffer.from(challenge))
      )
        throw new Error("Callback verification failed");
    },
    deliver: (subscription, event, previousSecret) => signed(subscription, event, event.eventId, previousSecret)
  };
}
module.exports = { publicAddress, callbackUrl, signingKey, signature, post, createTransport };
