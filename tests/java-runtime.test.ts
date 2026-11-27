import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

function executable(name: string): string {
  const resolved = Bun.which(name);
  if (!resolved) throw new Error(`Java runtime fixtures require ${name}`);
  return resolved;
}

// Capture tool locations once; no fixture inherits or mutates the operator's environment.
const executables = Object.freeze({
  bun: process.execPath,
  shell: executable("sh"),
  dirname: executable("dirname"),
  mkdir: executable("mkdir"),
});
const runtimeUrl = new URL("../src/minecraft/client.ts", import.meta.url).href;
const gradlew = fileURLToPath(new URL("../mod/gradlew", import.meta.url));
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface JavaFixture {
  root: string;
  javaHome: string;
  pathBin: string;
  toolsBin: string;
  gradleHome: string;
  homeJava: string;
  pathJava: string;
}

function fixture(): JavaFixture {
  const root = mkdtempSync(path.join(tmpdir(), "gameharness-java-runtime-"));
  roots.push(root);
  const javaHome = path.join(root, "selected jdk 21");
  const pathBin = path.join(root, "path-bin");
  const toolsBin = path.join(root, "wrapper-tools");
  const gradleHome = path.join(root, "gradle-cache");
  for (const directory of [path.join(javaHome, "bin"), pathBin, toolsBin, path.join(gradleHome, "gradle-8.11.1/bin")])
    mkdirSync(directory, { recursive: true });
  const homeJava = path.join(javaHome, "bin/java");
  const pathJava = path.join(pathBin, "java");
  for (const [file, marker] of [[homeJava, "java-home"], [pathJava, "path-java"]] as const)
    writeFileSync(file, `#!${executables.shell}\nprintf '%s\\n' '${marker}' "$@"\n`, { mode: 0o700 });
  symlinkSync(executables.dirname, path.join(toolsBin, "dirname"));
  symlinkSync(executables.mkdir, path.join(toolsBin, "mkdir"));

  // Substitute only the external Gradle executable. The repository wrapper still runs unchanged.
  // Refuse any non-fixture Java so the red phase cannot accidentally start a real installed JVM.
  writeFileSync(path.join(gradleHome, "gradle-8.11.1/bin/gradle"), `#!${executables.shell}
set -eu
if [ -n "\${JAVA_HOME:-}" ]; then
  java="$JAVA_HOME/bin/java"
else
  java="$(command -v java)"
fi
if [ "$java" != "$TEST_JAVA" ]; then
  printf 'Refusing non-fixture Java: %s\\n' "$java" >&2
  exit 73
fi
exec "$java" "$@"
`, { mode: 0o700 });
  return { root, javaHome, pathBin, toolsBin, gradleHome, homeJava, pathJava };
}

function runtimeSelection(f: JavaFixture, useJavaHome: boolean) {
  const expectedJava = useJavaHome ? f.homeJava : f.pathJava;
  // A fresh import observes only this subprocess's JAVA_HOME/PATH. Execute the actual exported
  // JAVA under the same restricted child PATH used by native launchers, not a resolver copy.
  const source = `
import { spawnSync } from "node:child_process";
import { JAVA } from ${JSON.stringify(runtimeUrl)};
const result = { java: JAVA };
if (JAVA === process.env.TEST_JAVA) {
  const child = spawnSync(JAVA, ["runtime-probe"], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME, LANG: "C.UTF-8" },
  });
  Object.assign(result, { status: child.status, stdout: child.stdout, stderr: child.stderr, error: child.error?.message });
}
console.log(JSON.stringify(result));
`;
  const child = spawnSync(executables.bun, ["--no-env-file", "--eval", source], {
    cwd: f.root,
    encoding: "utf8",
    timeout: 10000,
    env: {
      HOME: f.root,
      LANG: "C.UTF-8",
      PATH: f.pathBin,
      TEST_JAVA: expectedJava,
      ...(useJavaHome ? { JAVA_HOME: f.javaHome } : {}),
    },
  });
  expect(child.error).toBeUndefined();
  expect(child.stderr).toBe("");
  expect(child.status).toBe(0);
  return JSON.parse(child.stdout);
}

test("runtime JAVA_HOME overrides a competing PATH Java and runs with a restricted child PATH", () => {
  const f = fixture();
  expect(runtimeSelection(f, true)).toEqual({
    java: f.homeJava,
    status: 0,
    stdout: "java-home\nruntime-probe\n",
    stderr: "",
  });
});

test("runtime resolves PATH Java absolutely before a restricted child PATH replaces it", () => {
  const f = fixture();
  expect(runtimeSelection(f, false)).toEqual({
    java: f.pathJava,
    status: 0,
    stdout: "path-java\nruntime-probe\n",
    stderr: "",
  });
});

for (const useJavaHome of [true, false]) {
  test(`Gradle wrapper ${useJavaHome ? "preserves explicit JAVA_HOME over competing PATH Java" : "leaves absent JAVA_HOME unset so Gradle uses PATH Java"}`, () => {
    const f = fixture();
    const child = spawnSync(executables.shell, [gradlew, "wrapper-probe"], {
      cwd: f.root,
      encoding: "utf8",
      timeout: 10000,
      env: {
        HOME: f.root,
        LANG: "C.UTF-8",
        PATH: [f.pathBin, f.toolsBin].join(path.delimiter),
        GAMEHARNESS_GRADLE_HOME: f.gradleHome,
        TEST_JAVA: useJavaHome ? f.homeJava : f.pathJava,
        ...(useJavaHome ? { JAVA_HOME: f.javaHome } : {}),
      },
    });
    expect(child.error).toBeUndefined();
    expect(child.stderr).toBe("");
    expect(child.status).toBe(0);
    expect(child.stdout).toBe(`${useJavaHome ? "java-home" : "path-java"}\n--no-daemon\nwrapper-probe\n`);
  });
}
