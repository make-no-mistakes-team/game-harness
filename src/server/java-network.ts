import { isIP } from "node:net";

const DEFAULT_NON_PROXY_HOSTS = [
  "localhost",
  "127.*",
  "[::1]",
  "0.0.0.0",
  "[::0]",
];

function isHostname(value: string): boolean {
  const name = value.endsWith(".") ? value.slice(0, -1) : value;
  return (
    name.length > 0 &&
    name.length <= 253 &&
    name
      .split(".")
      .every(
        (label) =>
          label.length <= 63 &&
          /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label),
      )
  );
}

function proxyArguments(
  value: string | undefined,
  protocol: "http" | "https",
): string[] {
  if (value === undefined) return [];
  const invalid = () => new Error("Unsupported Java proxy configuration.");
  // Inspect the raw authority/path too: URL normalizes some forbidden forms.
  const match = /^http:\/\/([^/?#]+)\/?$/i.exec(value);
  if (!match || /[\s\\]/.test(value) || match[1]!.includes("@"))
    throw invalid();
  let proxy: URL;
  try {
    proxy = new URL(value);
  } catch {
    throw invalid();
  }
  const hostname = proxy.hostname.startsWith("[")
    ? proxy.hostname.slice(1, -1)
    : proxy.hostname;
  const port = proxy.port === "" ? 80 : Number(proxy.port);
  if (
    (!isIP(hostname) && !isHostname(hostname)) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  )
    throw invalid();
  return [
    `-D${protocol}.proxyHost=${hostname}`,
    `-D${protocol}.proxyPort=${port}`,
  ];
}

function nonProxyHosts(value: string | undefined): string[] {
  const patterns: string[] = [];
  const invalid = () => new Error("Unsupported Java NO_PROXY configuration.");
  for (const entry of value?.split(",") ?? []) {
    const pattern = entry.trim().toLowerCase();
    if (!pattern) continue;
    if (pattern === "*") {
      patterns.push("*");
      continue;
    }
    if (pattern.includes("/") || pattern.includes("%")) throw invalid();
    const address =
      pattern.startsWith("[") && pattern.endsWith("]")
        ? pattern.slice(1, -1)
        : pattern;
    const family = isIP(address);
    if (family) {
      if (pattern.startsWith("[") && family !== 6) throw invalid();
      patterns.push(family === 6 ? `[${address}]` : address);
      continue;
    }
    const subdomainsOnly = pattern.startsWith("*.");
    const domain = subdomainsOnly
      ? pattern.slice(2)
      : pattern.startsWith(".")
        ? pattern.slice(1)
        : pattern;
    if (!isHostname(domain) || /^[\d.]+$/.test(domain)) throw invalid();
    if (!subdomainsOnly) patterns.push(domain);
    patterns.push(`*.${domain}`);
  }
  return patterns;
}

/** Translate only explicit proxy routing; no ambient JVM options or credentials. */
export function javaProxyArguments(host: NodeJS.ProcessEnv): string[] {
  const fallback = host.ALL_PROXY ?? host.all_proxy;
  const http = proxyArguments(
    host.HTTP_PROXY ?? host.http_proxy ?? fallback,
    "http",
  );
  const https = proxyArguments(
    host.HTTPS_PROXY ?? host.https_proxy ?? fallback,
    "https",
  );
  if (http.length === 0 && https.length === 0) return [];
  const bypasses = nonProxyHosts(host.NO_PROXY ?? host.no_proxy);
  // The JVM uses http.nonProxyHosts for both HTTP and HTTPS destinations.
  return [
    ...http,
    ...https,
    `-Dhttp.nonProxyHosts=${[...DEFAULT_NON_PROXY_HOSTS, ...bypasses].join("|")}`,
  ];
}
