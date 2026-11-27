import { expect, test } from "bun:test";
import { javaProxyArguments } from "../src/minecraft/java-network.ts";

const secret = "synthetic-proxy-password-DO-NOT-LOG-84721";
const selected = {
  HTTP_PROXY: "http://127.0.0.1:18080",
  HTTPS_PROXY: "http://127.0.0.1:18081",
};

function rejectsPrivately(
  environment: NodeJS.ProcessEnv,
  sensitive: string[] = [],
) {
  let failure: unknown;
  try {
    javaProxyArguments(environment);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  const message = String(failure);
  for (const value of [secret, ...sensitive])
    expect(message).not.toContain(value);
}

// Host CI deliberately needs no JDK. Actual Java 21 ProxySelector and HTTP/CONNECT
// behavior is exercised by the separate, private installer preparation proof.
for (const value of [
  "",
  "   ",
  "socks5://127.0.0.1:18080",
  "https://127.0.0.1:18080",
  "http://127.0.0.1:0",
  "http://127.0.0.1:65536",
  "http://127.0.0.1:invalid",
  `http://operator:${secret}@127.0.0.1:18080`,
  `http://127.0.0.1:18080/${secret}`,
  `http://127.0.0.1:18080?password=${secret}`,
  `http://127.0.0.1:18080#${secret}`,
  "http://127.0.0.1:18080?",
  "http://127.0.0.1:18080#",
  "http://127.0.0.1:18080\\private",
]) {
  test(`configured unsupported proxy fails closed: case ${JSON.stringify(value).replaceAll(secret, "[redacted]")}`, () => {
    rejectsPrivately({ HTTP_PROXY: value }, value ? [value] : []);
  });
}

for (const key of [
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
]) {
  test(`${key} never exposes configured proxy credentials in an error`, () => {
    const value = `http://operator:${secret}@proxy.invalid:8080`;
    rejectsPrivately({ [key]: value }, [value, "operator", "proxy.invalid"]);
  });
}

for (const value of [
  "example.test:443",
  "127.0.0.1:80",
  "[::1]:443",
  "10.0.0.0/8",
  "192.168.0.0/16",
  "2001:db8::/32",
  "https://example.test",
  "service.*.example.test",
  "*example.test",
  `operator:${secret}@example.test`,
]) {
  test(`unrepresentable NO_PROXY fails closed: ${JSON.stringify(value).replaceAll(secret, "[redacted]")}`, () => {
    rejectsPrivately({ ...selected, NO_PROXY: value }, [value]);
  });
}

test("lowercase no_proxy is subject to the same fail-closed policy", () => {
  rejectsPrivately({ ...selected, no_proxy: "10.0.0.0/8" }, ["10.0.0.0/8"]);
});

test("an explicitly empty protocol proxy cannot silently fall back", () => {
  rejectsPrivately({
    HTTP_PROXY: "",
    http_proxy: selected.HTTP_PROXY,
    ALL_PROXY: selected.HTTP_PROXY,
  });
  rejectsPrivately({ HTTPS_PROXY: "", ALL_PROXY: selected.HTTPS_PROXY });
});

test("a fallback still fails closed when the other protocol needs it", () => {
  rejectsPrivately({
    HTTP_PROXY: selected.HTTP_PROXY,
    ALL_PROXY: `socks5://operator:${secret}@fallback.invalid:1080`,
  });
  rejectsPrivately({
    HTTPS_PROXY: selected.HTTPS_PROXY,
    all_proxy: `http://operator:${secret}@fallback.invalid:1080`,
  });
});
