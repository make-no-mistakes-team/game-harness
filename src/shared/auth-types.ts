export interface ModelOption {
  id: string;
  name: string;
  provider: string;
  context_window: number | null;
  input_modalities?: readonly string[];
  capability_provenance?: "discovered_sdk_descriptor_not_live_vision";
}

export interface AuthState {
  status:
    | "signed_out"
    | "authorizing"
    | "discovering"
    | "ready"
    | "unavailable"
    | "error";
  authenticated: boolean;
  provider: "openai-codex";
  account_label: string | null;
  models: ModelOption[];
  login: null | {
    id: string;
    mode: "browser" | "device";
    url: string | null;
    instructions: string | null;
    prompt: null | { label: string; secret: boolean; allow_empty: boolean };
  };
  error: string | null;
}

