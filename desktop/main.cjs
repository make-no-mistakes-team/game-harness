const { app, BrowserWindow, dialog, shell, session } = require("electron");
const { spawn } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const { existsSync, mkdirSync } = require("node:fs");
const path = require("node:path");

app.setName("GameHarness");
const root = path.resolve(__dirname, "..");
let window = null;
let backend = null;
let backendExited = true;
let stopping = false;
let shutdownTimer = null;
let origin = null;
let startupSettled = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });
  void app
    .whenReady()
    .then(start)
    .catch(() => {
      dialog.showErrorBox(
        "GameHarness could not start",
        "The desktop could not initialize. Check the Electron installation and start GameHarness again.",
      );
      app.quit();
    });
}

function externalUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port)
      return null;
    const oauth = [
      "auth.openai.com",
      "auth0.openai.com",
      "login.openai.com",
      "platform.openai.com",
    ].includes(url.hostname);
    const eula =
      url.hostname === "www.minecraft.net" &&
      url.pathname === "/eula" &&
      !url.search &&
      !url.hash;
    return oauth || eula ? url.href : null;
  } catch {
    return null;
  }
}

async function openExternal(value) {
  const safe = externalUrl(value);
  if (!safe) return;
  try {
    await shell.openExternal(safe);
  } catch {
    dialog.showErrorBox(
      "Browser could not open",
      "Open your system browser and retry authorization from Settings. No game control has changed.",
    );
  }
}

function showMessage(title, detail) {
  if (!window || window.isDestroyed()) return;
  const escape = (value) =>
    value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  const document = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>GameHarness</title><style>html{color-scheme:dark;background:#08050b;color:#f2f4f2;font:16px/1.6 sans-serif}body{margin:64px;max-width:70ch}h1{font-size:24px}p{color:#b5c1bf}strong{color:#ff9e93}</style><h1>${escape(title)}</h1><p>${escape(detail)}</p><p>GameHarness does not attach to another service or replace an unverified game connection.</p></html>`;
  void window.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(document)}`,
  );
  window.show();
}

async function start() {
  session.defaultSession.setPermissionRequestHandler(
    (_contents, _permission, callback) => callback(false),
  );
  session.defaultSession.setPermissionCheckHandler(() => false);
  window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 650,
    backgroundColor: "#08050b",
    title: "GameHarness",
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      navigateOnDragDrop: false,
      spellcheck: false,
    },
  });
  window.removeMenu();
  window.webContents.setWindowOpenHandler(({ url }) => {
    void openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    event.preventDefault();
    void openExternal(url);
  });
  window.webContents.on("will-redirect", (event) => event.preventDefault());
  window.webContents.on("will-attach-webview", (event) =>
    event.preventDefault(),
  );
  window.webContents.on("render-process-gone", () => {
    showMessage(
      "The workspace renderer stopped",
      "Close GameHarness to safely stop its owned backend and client, then reopen it. No manual gameplay fallback is enabled.",
    );
  });
  window.on("close", (event) => {
    if (backend && !backendExited) {
      event.preventDefault();
      beginShutdown();
    }
  });
  window.on("closed", () => {
    window = null;
  });
  showMessage(
    "Starting GameHarness",
    "Starting the owned local backend and waiting for its readiness handshake. No game or model run is automatically started.",
  );

  if (!existsSync(path.join(root, "dist/web/index.html"))) {
    showMessage(
      "The workspace has not been built",
      "Run bun run build from the GameHarness project, then start again. No backend was launched.",
    );
    return;
  }
  const bun = process.env.GAMEHARNESS_BUN;
  if (!bun || !path.isAbsolute(bun) || !existsSync(bun)) {
    showMessage(
      "Bun runtime is unavailable",
      "Start GameHarness with bun scripts/start.ts so the desktop receives the installed Bun runtime path.",
    );
    return;
  }
  const dataDir = path.resolve(
    process.env.GAMEHARNESS_DATA_DIR ||
      path.join(app.getPath("userData"), "runtime"),
  );
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const nonce = randomBytes(16).toString("hex");
  backendExited = false;
  backend = spawn(
    "flock",
    [
      "--nonblock",
      "--no-fork",
      path.join(dataDir, "app.lock"),
      bun,
      path.join(root, "src/server/index.ts"),
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        GAMEHARNESS_DATA_DIR: dataDir,
        GAMEHARNESS_LOCK_HELD: "1",
        GAMEHARNESS_DESKTOP: "1",
        GAMEHARNESS_READY_NONCE: nonce,
        GAMEHARNESS_PORT: process.env.GAMEHARNESS_PORT || "0",
        NODE_ENV: process.env.NODE_ENV || "production",
      },
      // The backend watches stdin EOF as the desktop ownership fence, including crashes.
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let output = "";
  const startupTimer = setTimeout(() => {
    if (startupSettled || stopping) return;
    startupSettled = true;
    showMessage(
      "Backend readiness timed out",
      "The owned backend did not confirm readiness within 90 seconds. Closing it now; cleanup must finish before the desktop can exit.",
    );
    beginShutdown();
  }, 90000);
  backend.stdout.setEncoding("utf8");
  backend.stdout.on("data", (chunk) => {
    if (startupSettled || stopping) return;
    output += chunk;
    if (output.length > 131072) {
      startupSettled = true;
      clearTimeout(startupTimer);
      showMessage(
        "Backend handshake failed",
        "The owned backend returned an oversized startup record. Closing the owned process; no other service will be reused.",
      );
      beginShutdown();
      return;
    }
    let end;
    while ((end = output.indexOf("\n")) >= 0) {
      const line = output.slice(0, end).trim();
      output = output.slice(end + 1);
      if (!line.startsWith("GAMEHARNESS_READY ")) continue;
      try {
        const ready = JSON.parse(line.slice("GAMEHARNESS_READY ".length));
        const address = new URL(ready.origin);
        if (
          ready.nonce !== nonce ||
          address.protocol !== "http:" ||
          address.hostname !== "127.0.0.1" ||
          !address.port ||
          address.pathname !== "/" ||
          address.search ||
          address.hash ||
          address.username ||
          address.password
        )
          throw new Error("Invalid readiness record");
        startupSettled = true;
        clearTimeout(startupTimer);
        origin = address.origin;
        void confirmAndLoad(nonce);
      } catch {
        startupSettled = true;
        clearTimeout(startupTimer);
        showMessage(
          "Backend ownership could not be confirmed",
          "The startup handshake did not match this desktop instance. Closing only the process started by this window.",
        );
        beginShutdown();
      }
      break;
    }
  });
  // Backend output is not forwarded into the renderer or copied to project logs.
  backend.stderr.on("data", () => {});
  backend.on("error", (error) => {
    backendExited = true;
    clearTimeout(startupTimer);
    const code = typeof error.code === "string" ? error.code : "unknown";
    showMessage(
      "The local backend could not start",
      `Launch error ${code}. Check that Bun and the system flock utility are installed and that the data directory is writable. No existing service was reused.`,
    );
    if (stopping) app.quit();
  });
  backend.on("exit", (code) => {
    backendExited = true;
    clearTimeout(startupTimer);
    clearTimeout(shutdownTimer);
    if (stopping) {
      app.quit();
      return;
    }
    showMessage(
      "The owned backend stopped",
      code === 0
        ? "The local backend has closed. Close this window and reopen GameHarness to start a new owned session."
        : `The backend exited with code ${code ?? "unknown"} before a safe working session could continue. Another instance may hold the selected data lock, or backend/native setup failed. No unrelated process was stopped. Check local setup before restarting.`,
    );
  });
}

async function confirmAndLoad(nonce) {
  try {
    const response = await fetch(`${origin}/v1/ready`, {
      signal: AbortSignal.timeout(10000),
      redirect: "error",
    });
    const ready = await response.json();
    if (
      !response.ok ||
      ready.ready !== true ||
      ready.instance !== nonce ||
      backendExited ||
      stopping
    )
      throw new Error("Readiness ownership mismatch");
    if (!window || window.isDestroyed()) return;
    await window.loadURL(`${origin}/`);
    window.show();
    console.log(`GAMEHARNESS_DESKTOP_READY ${JSON.stringify({ origin })}`);
  } catch {
    if (stopping) return;
    showMessage(
      "Backend readiness could not be confirmed",
      "The authenticated local workspace was not loaded because the ownership/readiness check failed. Closing the owned backend now.",
    );
    beginShutdown();
  }
}

function beginShutdown() {
  if (stopping) {
    if (backend && !backendExited) backend.kill("SIGTERM");
    return;
  }
  stopping = true;
  if (!backend || backendExited) {
    app.quit();
    return;
  }
  showMessage(
    "Closing GameHarness safely",
    "Waiting for owned program, sandbox, Minecraft client, and backend cleanup. This window stays open until the backend confirms exit; unrelated services are untouched.",
  );
  backend.kill("SIGTERM");
  shutdownTimer = setTimeout(() => {
    if (backendExited) return;
    showMessage(
      "Cleanup is still pending",
      "The owned backend has not confirmed cleanup after 30 seconds. This window remains open rather than force-killing a game or reporting successful shutdown. After resolving the backend/native prerequisite, close this window again to request a cleanup retry. The desktop exits only when its backend exits.",
    );
  }, 30000);
}

app.on("before-quit", (event) => {
  if (backend && !backendExited) {
    event.preventDefault();
    beginShutdown();
  }
});
app.on("window-all-closed", () => {
  if (backendExited) app.quit();
  else beginShutdown();
});
process.once("SIGINT", beginShutdown);
process.once("SIGTERM", beginShutdown);
