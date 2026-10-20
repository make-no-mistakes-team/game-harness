const NETWORK_ENVIRONMENT = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
] as const;

/** Trusted OAuth needs the operator's network route, not their ambient API keys. */
export function authWorkerEnvironment(
  host: NodeJS.ProcessEnv,
): Record<string, string> {
  const environment: Record<string, string> = {
    LANG: "C.UTF-8",
    NODE_ENV: "production",
  };
  for (const key of NETWORK_ENVIRONMENT) {
    const value = host[key];
    if (value) environment[key] = value;
  }
  return environment;
}
