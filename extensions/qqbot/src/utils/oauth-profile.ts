import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type OAuthCredential = {
  type: "oauth";
  provider: string;
  access?: string;
  refresh?: string;
  expires?: number;
  [key: string]: unknown;
};

type AuthProfileStore = {
  version?: number;
  profiles?: Record<string, OAuthCredential | Record<string, unknown>>;
  [key: string]: unknown;
};

export type ResolvedOAuthProfileToken = {
  token: string;
  profileId: string;
  provider: string;
  refreshed: boolean;
};

const OPENAI_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
const DEFAULT_AUTH_AGENT_ID = "main";
const REFRESH_SKEW_MS = 60_000;

function dynamicImport(specifier: string): Promise<any> {
  return new Function("specifier", "return import(specifier)")(specifier);
}

function getAccountId(accessToken: string): string | undefined {
  try {
    const payload = accessToken.split(".")[1];
    if (!payload) return undefined;
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = Buffer.from(normalized, "base64").toString("utf8");
    const json = JSON.parse(decoded);
    const auth = json?.["https://api.openai.com/auth"];
    return typeof auth?.chatgpt_account_id === "string" ? auth.chatgpt_account_id : undefined;
  } catch {
    return undefined;
  }
}

function resolveStateDir(): string {
  return process.env.OPENCLAW_STATE_DIR?.trim()
    || path.join(os.homedir(), ".openclaw");
}

function resolveAgentId(): string {
  return process.env.OPENCLAW_AGENT_ID?.trim() || DEFAULT_AUTH_AGENT_ID;
}

export function resolveAuthProfilesPath(): string {
  const explicit = process.env.OPENCLAW_AUTH_PROFILES_PATH?.trim();
  if (explicit) return path.resolve(explicit);

  const agentDir = process.env.OPENCLAW_AGENT_DIR?.trim();
  if (agentDir) return path.resolve(agentDir, "auth-profiles.json");

  return path.join(resolveStateDir(), "agents", resolveAgentId(), "agent", "auth-profiles.json");
}

function readAuthProfileStore(authProfilesPath: string): AuthProfileStore {
  return JSON.parse(fs.readFileSync(authProfilesPath, "utf8")) as AuthProfileStore;
}

function writeAuthProfileStore(authProfilesPath: string, store: AuthProfileStore): void {
  const tmpPath = `${authProfilesPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmpPath, authProfilesPath);
  try {
    fs.chmodSync(authProfilesPath, 0o600);
  } catch {
    // Best effort on Windows filesystems.
  }
}

async function refreshWithOpenClawHelper(provider: string, credential: OAuthCredential): Promise<OAuthCredential | null> {
  try {
    const mod = await dynamicImport("@mariozechner/pi-ai/oauth");
    if (typeof mod?.getOAuthApiKey !== "function") return null;
    const result = await mod.getOAuthApiKey(provider, {
      [provider]: {
        access: credential.access,
        refresh: credential.refresh,
        expires: credential.expires,
        provider: credential.provider,
        accountId: credential.accountId,
        email: credential.email,
      },
    });
    if (!result?.newCredentials?.access) return null;
    return {
      ...credential,
      ...result.newCredentials,
      type: "oauth",
      provider,
    };
  } catch {
    return null;
  }
}

async function refreshOpenAICodexDirect(credential: OAuthCredential): Promise<OAuthCredential> {
  if (!credential.refresh) throw new Error("OAuth profile is missing refresh token");

  const response = await fetch(OPENAI_CODEX_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: credential.refresh,
      client_id: OPENAI_CODEX_CLIENT_ID,
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI Codex OAuth refresh failed: HTTP ${response.status}`);
  }

  const json = await response.json() as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!json.access_token || !json.refresh_token || typeof json.expires_in !== "number") {
    throw new Error("OpenAI Codex OAuth refresh response missing token fields");
  }

  return {
    ...credential,
    type: "oauth",
    provider: "openai-codex",
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
    accountId: getAccountId(json.access_token) || credential.accountId,
  };
}

async function refreshOAuthCredential(credential: OAuthCredential): Promise<OAuthCredential> {
  const provider = String(credential.provider || "").trim();
  const helperCredential = await refreshWithOpenClawHelper(provider, credential);
  if (helperCredential) return helperCredential;
  if (provider === "openai-codex") return refreshOpenAICodexDirect(credential);
  throw new Error(`OAuth refresh is not supported for provider ${provider || "(missing)"}`);
}

export async function resolveOAuthProfileToken(profileId: string): Promise<ResolvedOAuthProfileToken> {
  const trimmedProfileId = profileId.trim();
  if (!trimmedProfileId) throw new Error("OAuth profile id is empty");

  const authProfilesPath = resolveAuthProfilesPath();
  if (!fs.existsSync(authProfilesPath)) {
    throw new Error(`OAuth profile store not found: ${authProfilesPath}`);
  }

  const store = readAuthProfileStore(authProfilesPath);
  const profiles = store.profiles || {};
  const credential = profiles[trimmedProfileId] as OAuthCredential | undefined;
  if (!credential) throw new Error(`OAuth profile not found: ${trimmedProfileId}`);
  if (credential.type !== "oauth") throw new Error(`Auth profile ${trimmedProfileId} is not OAuth`);
  if (!credential.access) throw new Error(`OAuth profile ${trimmedProfileId} is missing access token`);

  const provider = String(credential.provider || trimmedProfileId.split(":", 1)[0] || "").trim();
  const expires = typeof credential.expires === "number" ? credential.expires : 0;
  if (expires > Date.now() + REFRESH_SKEW_MS) {
    return { token: credential.access, profileId: trimmedProfileId, provider, refreshed: false };
  }

  try {
    const refreshed = await refreshOAuthCredential({ ...credential, provider });
    profiles[trimmedProfileId] = refreshed;
    store.profiles = profiles;
    writeAuthProfileStore(authProfilesPath, store);
    if (!refreshed.access) throw new Error(`OAuth profile ${trimmedProfileId} refresh returned no access token`);
    return { token: refreshed.access, profileId: trimmedProfileId, provider, refreshed: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `OAuth profile ${trimmedProfileId} is expired and refresh failed: ${message}. Run: openclaw models auth login --provider ${provider || "openai-codex"} --set-default`
    );
  }
}

export async function resolveBearerTokenFromApiKeyOrProfile(params: {
  apiKey?: string;
  authProfile?: string;
}): Promise<string> {
  const profile = params.authProfile?.trim();
  if (profile) return (await resolveOAuthProfileToken(profile)).token;
  return params.apiKey?.trim() || "";
}
