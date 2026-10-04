const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

function exactOrigin(value) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.origin !== value)
      throw new Error();
    return url;
  } catch {
    throw new Error(
      "Origins must be exact HTTP(S) origins without credentials, paths or trailing slashes.",
    );
  }
}

export function createOriginPolicy(appOrigin, rawAliases = "") {
  const target = exactOrigin(appOrigin);
  if (typeof rawAliases !== "string")
    throw new Error("APP_PROXY_ORIGINS must be a comma-separated string.");
  const aliases = rawAliases.trim()
    ? rawAliases.split(",").map((v) => v.trim())
    : [];
  if (aliases.length > 8)
    throw new Error("APP_PROXY_ORIGINS allows at most eight exact origins.");
  for (const alias of aliases) {
    const url = exactOrigin(alias);
    if (!loopbackHosts.has(url.hostname))
      throw new Error(
        "APP_PROXY_ORIGINS only allows explicit loopback origins.",
      );
  }
  if (
    aliases.length &&
    (target.protocol !== "https:" || loopbackHosts.has(target.hostname))
  )
    throw new Error(
      "Proxy compatibility requires an external HTTPS APP_ORIGIN.",
    );
  return { target: target.origin, aliases: new Set(aliases) };
}

export function browserOriginAllowed(headers, policy) {
  // Browser metadata is an additional restriction, never an alternative to checking Origin.
  if (headers["sec-fetch-site"] === "cross-site") return false;
  if (headers.origin === policy.target) return true;
  if (
    !policy.aliases.has(headers.origin) ||
    headers["sec-fetch-site"] !== "same-origin"
  )
    return false;
  // An explicitly configured rewriting proxy may change Origin while preserving Referer.
  // Require both browser signals; do not derive trust from Host/X-Forwarded-* headers.
  try {
    const referer = new URL(headers.referer);
    return (
      !referer.username && !referer.password && referer.origin === policy.target
    );
  } catch {
    return false;
  }
}
