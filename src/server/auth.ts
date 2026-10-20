import { constants } from "node:fs";
import { chmod, lstat, mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Subprocess } from "bun";
import {
  AuthStorage,
  resolveCredentialIdentityKey,
} from "@oh-my-pi/pi-ai/auth-storage";
import type {
  OAuthCredential,
  SessionRestrictionLease,
  StoredAuthCredential,
} from "@oh-my-pi/pi-ai/auth-storage";
import type { ApiKeyResolveContext } from "@oh-my-pi/pi-ai/auth-retry";
import { Agent } from "@oh-my-pi/pi-agent-core/agent";
import type { AgentTool } from "@oh-my-pi/pi-agent-core/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { fetchCodexModels } from "@oh-my-pi/pi-catalog/discovery/codex";
import type { Model } from "@oh-my-pi/pi-catalog/types";
import { untilAborted } from "@oh-my-pi/pi-utils";
import { setTransports } from "@oh-my-pi/pi-utils/logger";
import type { AuthState } from "../shared/contracts.ts";
import {
  AUTH_MESSAGE_LIMIT,
  authWorkerMessageSchema,
  validatedAuthUrl,
} from "./auth-protocol.ts";
import type { AuthWorkerMessage } from "./auth-protocol.ts";
import { authWorkerEnvironment } from "./auth-network.ts";

const PROVIDER = "openai-codex";
const LOGIN_FAILURE =
  "OpenAI authorization could not complete. Check connectivity and account permissions, then try again.";
// Upstream refresh errors can contain response bodies. Keep them out of both
// generic application logs and OMP's default home-directory file transport.
setTransports({ console: false, file: false });
type LoginJob = {
  id: string;
  mode: "browser" | "device";
  child: Subprocess<"pipe", "pipe", "ignore">;
  cancelled: boolean;
  committing: boolean;
  done: Promise<void>;
};
type AgentScope = {
  sessionId: string;
  restriction: SessionRestrictionLease;
  active: boolean;
  operations: Set<Promise<unknown>>;
};

async function privateFiles(directory: string): Promise<void> {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error(
      "The authentication directory must be a private real directory",
    );
  await chmod(directory, 0o700);
  for (const name of [
    "gameharness.sqlite",
    "gameharness.sqlite-wal",
    "gameharness.sqlite-shm",
  ]) {
    const path = join(directory, name);
    const entry = await lstat(path).catch((error: unknown) => {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      )
        return null;
      throw error;
    });
    if (!entry) continue;
    if (!entry.isFile() || entry.isSymbolicLink())
      throw new Error("Authentication storage contains an unsafe file");
    await chmod(path, 0o600);
  }
}

/** GameHarness-only subscription credentials; no OMP/Codex home or ambient-key imports. */
export class AuthManager {
  readonly #auth: AuthStorage;
  readonly #directory: string;
  readonly #onChange: () => void;
  #state: AuthState = {
    status: "signed_out",
    authenticated: false,
    provider: PROVIDER,
    account_label: null,
    models: [],
    login: null,
    error: null,
  };
  #selectedId: number | null = null;
  #models = new Map<string, Model>();
  #job: LoginJob | null = null;
  #discovery: AbortController | null = null;
  #operations = new Set<Promise<unknown>>();
  #agents = new Map<Agent, AgentScope>();
  #credentialEpoch = 0;
  #ending = false;
  #closed = false;
  #closing: Promise<void> | null = null;
  #signingOut: Promise<void> | null = null;

  private constructor(
    auth: AuthStorage,
    directory: string,
    onChange: () => void,
  ) {
    this.#auth = auth;
    this.#directory = directory;
    this.#onChange = onChange;
  }

  static async create(
    dataDir: string,
    onChange: () => void,
  ): Promise<AuthManager> {
    const directory = join(dataDir, "auth");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await privateFiles(directory);
    const dbPath = join(directory, "gameharness.sqlite");
    const file = await open(
      dbPath,
      constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await file.chmod(0o600);
    } finally {
      await file.close();
    }
    const auth = await AuthStorage.create(dbPath, {
      configValueResolver: async (value) => value,
      sourceLabel: "GameHarness",
    });
    try {
      await auth.credentials.reload();
      await privateFiles(directory);
      const manager = new AuthManager(auth, directory, onChange);
      const row = auth.credentials
        .list(PROVIDER)
        .filter(
          (
            entry,
          ): entry is StoredAuthCredential & { credential: OAuthCredential } =>
            entry.credential.type === "oauth",
        )
        .sort(
          (a, b) =>
            (b.credential.authorizedAt ?? 0) -
              (a.credential.authorizedAt ?? 0) || b.id - a.id,
        )[0];
      if (row) {
        manager.#select(row);
        // Existing app-owned human authorization can be refreshed at startup;
        // an empty store performs no provider request at all.
        void manager.refreshModels();
      }
      return manager;
    } catch {
      auth.close();
      throw new Error("GameHarness authentication storage could not be opened");
    }
  }

  snapshot(): AuthState {
    return structuredClone(this.#state);
  }

  async startLogin(mode: "browser" | "device"): Promise<AuthState> {
    this.#available();
    if (mode !== "browser" && mode !== "device")
      throw new Error("Choose browser or device login");
    if (this.#job) throw new Error("A login is already active");
    this.#cancelDiscovery();
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        fileURLToPath(new URL("./auth-worker.ts", import.meta.url)),
        mode,
      ],
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "ignore",
        // Preserve the trusted network route, but never ambient provider keys,
        // home paths, dotenv settings, logging configuration or preload flags.
        env: authWorkerEnvironment(process.env),
      },
    );
    const job: LoginJob = {
      id: crypto.randomUUID(),
      mode,
      child,
      cancelled: false,
      committing: false,
      done: Promise.resolve(),
    };
    this.#job = job;
    this.#state.status = "authorizing";
    this.#state.error = null;
    this.#state.login = {
      id: job.id,
      mode,
      url: null,
      instructions:
        mode === "browser"
          ? "Preparing browser authorization on callback port 1455…"
          : "Requesting a device authorization code…",
      prompt: null,
    };
    job.done = this.#track(this.#runLogin(job));
    this.#changed();
    return this.snapshot();
  }

  submitInput(loginId: string, value: string): void {
    this.#available();
    const job = this.#job;
    const prompt = this.#state.login?.prompt;
    if (
      !job ||
      job.id !== loginId ||
      job.cancelled ||
      job.committing ||
      !prompt
    )
      throw new Error("This login is not waiting for input");
    if (
      typeof value !== "string" ||
      Buffer.byteLength(value) > 8192 ||
      (!prompt.allow_empty && !value.trim())
    )
      throw new Error("Invalid login input");
    job.child.stdin.write(JSON.stringify({ type: "input", value }) + "\n");
    void Promise.resolve(job.child.stdin.flush()).catch(() => {
      job.child.kill("SIGKILL");
    });
    this.#state.login!.prompt = null;
    this.#changed();
  }

  async cancelLogin(loginId: string): Promise<void> {
    const job = this.#job;
    if (!job || job.id !== loginId)
      throw new Error("This login is no longer active");
    // Grant commit is the linearization point: it is not a cancellable login
    // after this point. Never report a persisted authorization as cancelled.
    if (job.committing) throw new Error("Authorization has already completed");
    job.cancelled = true;
    job.child.kill("SIGKILL");
    await job.done;
  }

  async logout(): Promise<void> {
    this.#available();
    const finished = Promise.withResolvers<void>();
    this.#signingOut = finished.promise;
    this.#ending = true;
    this.#credentialEpoch++;
    this.#cancelDiscovery();
    try {
      const job = this.#job;
      if (job) {
        job.cancelled = true;
        job.child.kill("SIGKILL");
        await job.done;
      }
      await this.#stopAgents();
      await this.#settleOperations();
      await this.#auth.credentials.remove(PROVIDER);
      await this.#auth.credentials.reload();
      // remove() clears the cache even if SQLite rejects its soft-delete.
      // reload() reads active disk rows and propagates read errors: only an
      // empty reloaded provider can truthfully be reported as signed out.
      if (this.#auth.credentials.list(PROVIDER).length)
        throw new Error("Persisted authorization remains active");
      await privateFiles(this.#directory);
      this.#selectedId = null;
      this.#models.clear();
      this.#state = {
        status: "signed_out",
        authenticated: false,
        provider: PROVIDER,
        account_label: null,
        models: [],
        login: null,
        error: null,
      };
      this.#changed();
    } catch {
      this.#models.clear();
      this.#state.models = [];
      this.#state.status = "error";
      this.#state.login = null;
      this.#state.error =
        "Local sign-out could not finish. Stop the application and check authentication storage permissions.";
      this.#changed();
      throw new Error(this.#state.error);
    } finally {
      this.#ending = false;
      this.#signingOut = null;
      finished.resolve();
    }
  }

  async refreshModels(): Promise<void> {
    this.#available();
    if (this.#job)
      throw new Error(
        "Finish or cancel authorization before refreshing models",
      );
    this.#cancelDiscovery();
    const id = this.#selectedId;
    if (id === null) return;
    const controller = new AbortController();
    this.#discovery = controller;
    this.#state.status = "discovering";
    this.#state.error = null;
    this.#changed();
    await this.#track(this.#discover(id, controller));
  }

  async createAgent(options: {
    modelId: string;
    systemPrompt: string[];
    tools: AgentTool[];
  }): Promise<Agent> {
    this.#available();
    const model = this.#models.get(options.modelId);
    const row = this.#auth.credentials
      .list(PROVIDER)
      .find((entry) => entry.id === this.#selectedId);
    if (!row || row.credential.type !== "oauth")
      throw new Error("Sign in to a GameHarness OpenAI account first");
    if (!model)
      throw new Error(
        "Choose a supported model from the authenticated account’s current discovery result",
      );
    const identity = resolveCredentialIdentityKey(PROVIDER, row.credential);
    if (!identity)
      throw new Error("This OAuth account has no routable identity");
    const sessionId = crypto.randomUUID();
    const restriction = this.#auth.sessions.restrict(PROVIDER, sessionId, [
      identity,
    ]);
    if (!this.#auth.sessions.pin(PROVIDER, sessionId, row.id)) {
      this.#auth.sessions.unrestrict(PROVIDER, sessionId, restriction);
      throw new Error("The selected OAuth account is unavailable");
    }
    const epoch = this.#credentialEpoch;
    const credentialId = row.id;
    const scope: AgentScope = {
      sessionId,
      restriction,
      active: true,
      operations: new Set(),
    };
    try {
      const agent = new Agent({
        sessionId,
        initialState: {
          model,
          systemPrompt: [...options.systemPrompt],
          tools: [...options.tools],
          messages: [],
        },
        intentTracing: false,
        getApiKey: (requested) => {
          this.#assertScope(epoch, credentialId, scope);
          if (
            requested.provider !== PROVIDER ||
            requested.id !== model.id ||
            requested.api !== model.api ||
            requested.baseUrl !== model.baseUrl
          )
            throw new Error(
              "This agent is authorized only for its selected Codex model",
            );
          const resolve = this.#auth.keys.resolver(PROVIDER, {
            sessionId,
            modelId: model.id,
            baseUrl: model.baseUrl,
          });
          return (context: ApiKeyResolveContext) =>
            untilAborted(context.signal, () =>
              this.#track(
                (async () => {
                  this.#assertScope(epoch, credentialId, scope);
                  try {
                    // Own the full resolver through leased refresh persistence.
                    // Caller cancellation ends only its wait, never that ownership.
                    const key = await resolve({
                      ...context,
                      signal: undefined,
                    });
                    this.#assertScope(epoch, credentialId, scope);
                    if (
                      !key ||
                      typeof key === "string" ||
                      key.credentialId !== credentialId ||
                      !key.apiKey
                    )
                      throw new Error("Credential unavailable");
                    return key;
                  } catch {
                    // Throw rather than returning undefined: some transports use
                    // ambient environment credentials when given no key.
                    throw new Error(
                      "The selected GameHarness OAuth account cannot authorize this request. Refresh models or sign in again.",
                    );
                  }
                })(),
                scope,
              ),
            );
        },
      });
      this.#agents.set(agent, scope);
      return agent;
    } catch {
      this.#auth.sessions.unrestrict(PROVIDER, sessionId, restriction);
      throw new Error("The authenticated model agent could not be created");
    }
  }

  async releaseAgent(agent: Agent): Promise<void> {
    const scope = this.#agents.get(agent);
    if (!scope) return;
    // Fence future/reused prompts before aborting. Removing the restriction
    // alone must never let a retained Agent borrow ambient credentials.
    scope.active = false;
    agent.abort("GameHarness model agent released");
    await agent.waitForIdle();
    // A cancelled transport may stop awaiting a resolver before its token
    // rotation finishes. Keep the account restriction installed until every
    // owned resolution has finished, so none can fall through to ambient keys.
    while (scope.operations.size)
      await Promise.allSettled([...scope.operations]);
    if (this.#agents.get(agent) !== scope) return;
    this.#auth.sessions.unrestrict(
      PROVIDER,
      scope.sessionId,
      scope.restriction,
    );
    this.#agents.delete(agent);
  }

  /**
   * Fence new work and drain credential transactions before closing SQLite.
   * The shutdown owner must await this promise before exiting the process.
   */
  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.#credentialEpoch++;
    this.#cancelDiscovery();
    this.#closing = this.#close();
    return this.#closing;
  }

  async #close(): Promise<void> {
    if (this.#signingOut) await this.#signingOut;
    const job = this.#job;
    if (job) {
      job.cancelled = true;
      job.child.kill("SIGKILL");
      await job.done;
    }
    await this.#stopAgents();
    await this.#settleOperations();
    this.#auth.close();
  }

  async #runLogin(job: LoginJob): Promise<void> {
    let grant: Extract<AuthWorkerMessage, { type: "grant" }>["grant"] | null =
      null;
    let failure: string | null = null;
    let terminal = false;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      job.child.kill("SIGKILL");
    }, 15 * 60_000);
    try {
      const decoder = new TextDecoder();
      let buffer = "";
      let total = 0;
      for await (const chunk of job.child.stdout) {
        total += chunk.byteLength;
        if (total > 512 * 1024)
          throw new Error("Invalid OAuth helper protocol");
        buffer += decoder.decode(chunk, { stream: true });
        if (Buffer.byteLength(buffer) > AUTH_MESSAGE_LIMIT)
          throw new Error("Invalid OAuth helper protocol");
        let end: number;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          if (terminal) throw new Error("Invalid OAuth helper protocol");
          const message = authWorkerMessageSchema.parse(JSON.parse(line));
          if (message.type === "grant") {
            grant = message.grant;
            terminal = true;
          } else if (message.type === "error") {
            failure = message.message;
            terminal = true;
          } else if (
            this.#job === job &&
            !job.cancelled &&
            !this.#closed &&
            !this.#ending
          )
            this.#loginMessage(job, message);
        }
      }
      const exit = await job.child.exited;
      if (buffer.trim() || exit !== 0 || !grant)
        throw new Error("OAuth helper did not complete");
      if (this.#job !== job || job.cancelled || this.#closed || this.#ending)
        return;
      const credential: OAuthCredential = {
        type: "oauth",
        ...grant,
        authorizedAt: Date.now(),
      };
      const identity = resolveCredentialIdentityKey(PROVIDER, credential);
      if (!identity) throw new Error("OAuth identity missing");
      // No await between the current-job fence and entry to upstream's local
      // synchronous SQLite transaction. Only the parent may commit grants.
      job.committing = true;
      this.#state.login = null;
      await this.#auth.credentials.upsert(PROVIDER, credential);
      await this.#auth.credentials.reload();
      await privateFiles(this.#directory);
      const row = this.#auth.credentials
        .list(PROVIDER)
        .find(
          (entry) =>
            entry.credential.type === "oauth" &&
            resolveCredentialIdentityKey(PROVIDER, entry.credential) ===
              identity,
        );
      if (!row) throw new Error("Committed OAuth identity missing");
      this.#select(row);
      this.#job = null;
      if (!this.#closed && !this.#ending) await this.refreshModels();
    } catch {
      if (this.#job === job) {
        this.#state.error =
          job.cancelled || this.#closed || this.#ending
            ? null
            : timedOut
              ? "Authorization timed out. Start a new login."
              : (failure ?? LOGIN_FAILURE);
      }
    } finally {
      clearTimeout(timeout);
      job.child.kill("SIGKILL");
      await job.child.exited;
      grant = null;
      if (this.#job === job) {
        this.#job = null;
        this.#state.login = null;
        this.#state.status =
          this.#selectedId !== null
            ? this.#models.size
              ? "ready"
              : "unavailable"
            : this.#state.error
              ? "error"
              : "signed_out";
        if (!this.#closed && !this.#ending) this.#changed();
      }
    }
  }

  #loginMessage(
    job: LoginJob,
    message: Extract<AuthWorkerMessage, { type: "auth" | "prompt" }>,
  ): void {
    const login = this.#state.login;
    if (!login || login.id !== job.id) return;
    if (message.type === "auth") {
      const full = validatedAuthUrl(message.url, job.mode);
      login.url = message.launch_url
        ? validatedAuthUrl(message.launch_url, job.mode, true)
        : full;
      login.instructions =
        message.instructions ??
        (job.mode === "browser"
          ? "Open this link on the backend machine and complete OpenAI sign-in. The callback uses localhost:1455."
          : "Complete OpenAI device authorization in your browser.");
    } else {
      login.prompt = {
        label: message.label,
        secret: message.secret,
        allow_empty: message.allow_empty,
      };
    }
    this.#changed();
  }

  async #discover(id: number, controller: AbortController): Promise<void> {
    let error =
      "Codex model discovery is unavailable. Check connectivity and refresh models.";
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(30_000),
    ]);
    try {
      // Upstream has no public instance drain; a signal passed into accessById
      // would race its leased refresh and detach persistence from our drain.
      // Track the uncancelled public operation, then cancel only this wait.
      // The dependency retains its own bounded token-exchange timeout.
      const access = await untilAborted(signal, () =>
        this.#track(this.#auth.oauth.accessById(PROVIDER, id)),
      );
      signal.throwIfAborted();
      if (!access?.ok) {
        error =
          "The saved OAuth account cannot currently provide access. Sign in again or retry refresh.";
        throw new Error("OAuth access unavailable");
      }
      const result = await fetchCodexModels({
        accessToken: access.accessToken,
        accountId: access.accountId,
        signal,
      });
      signal.throwIfAborted();
      if (result?.rejectedStatus) {
        error =
          result.rejectedStatus === 403
            ? "OpenAI denied this account’s Codex model access. Check subscription and workspace permissions."
            : "OpenAI rejected this account’s credentials. Sign in again.";
        throw new Error("Codex discovery rejected");
      }
      if (!result) throw new Error("Codex discovery unavailable");
      const models = result.models
        .map((spec) => buildModel(spec))
        .filter(
          (model) =>
            model.provider === PROVIDER &&
            model.api === "openai-codex-responses" &&
            model.kind === undefined &&
            model.input.includes("text") &&
            model.supportsTools !== false,
        );
      if (!models.length) {
        error =
          "OpenAI returned no supported text/tool models for this account. Check account permissions or refresh later.";
        throw new Error("No supported Codex models");
      }
      if (!this.#currentDiscovery(id, controller)) return;
      this.#models = new Map(models.map((model) => [model.id, model]));
      this.#state.models = [...this.#models.values()].map((model) => ({
        id: model.id,
        name: model.name,
        provider: PROVIDER,
        context_window: Number.isFinite(model.contextWindow)
          ? model.contextWindow
          : null,
      }));
      this.#state.status = "ready";
      this.#state.error = null;
      await privateFiles(this.#directory);
    } catch {
      if (!this.#currentDiscovery(id, controller)) return;
      this.#models.clear();
      this.#state.models = [];
      this.#state.status = "unavailable";
      this.#state.error = error;
    } finally {
      if (this.#currentDiscovery(id, controller)) {
        this.#discovery = null;
        this.#changed();
      }
    }
  }

  #select(row: StoredAuthCredential): void {
    if (row.credential.type !== "oauth")
      throw new Error("OAuth credential required");
    this.#selectedId = row.id;
    this.#models.clear();
    this.#state.models = [];
    this.#state.authenticated = true;
    this.#state.account_label = (row.credential.email ?? "OpenAI account")
      .replace(/[\x00-\x1f\x7f]/g, "")
      .slice(0, 320);
    this.#state.error = null;
  }

  #currentDiscovery(id: number, controller: AbortController): boolean {
    return (
      !this.#closed &&
      !this.#ending &&
      this.#selectedId === id &&
      this.#discovery === controller &&
      !controller.signal.aborted
    );
  }
  #cancelDiscovery(): void {
    this.#discovery?.abort();
    this.#discovery = null;
  }
  #available(): void {
    if (this.#closed || this.#ending)
      throw new Error("Authentication manager is closed or signing out");
  }
  #assertScope(epoch: number, id: number, scope: AgentScope): void {
    this.#available();
    if (
      !scope.active ||
      epoch !== this.#credentialEpoch ||
      !this.#auth.credentials
        .list(PROVIDER)
        .some((row) => row.id === id && row.credential.type === "oauth")
    )
      throw new Error("This agent’s OAuth authorization is no longer active");
  }
  #changed(): void {
    try {
      this.#onChange();
    } catch {
      /* UI invalidation cannot affect credential ownership. */
    }
  }
  #track<T>(operation: Promise<T>, scope?: AgentScope): Promise<T> {
    this.#operations.add(operation);
    scope?.operations.add(operation);
    const settled = () => {
      this.#operations.delete(operation);
      scope?.operations.delete(operation);
    };
    void operation.then(settled, settled);
    return operation;
  }
  async #settleOperations(): Promise<void> {
    while (this.#operations.size)
      await Promise.allSettled([...this.#operations]);
  }
  async #stopAgents(): Promise<void> {
    await Promise.all(
      [...this.#agents.keys()].map((agent) => this.releaseAgent(agent)),
    );
  }
}
