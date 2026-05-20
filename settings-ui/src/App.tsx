import {
  Bot,
  Braces,
  CheckCircle2,
  FileText,
  Gauge,
  Grid3X3,
  KeyRound,
  Mic2,
  Package,
  RefreshCw,
  Save,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

type JsonValue = any;

type Feature = {
  name: string;
  kind: string;
  enabled: boolean;
  provider: string;
  model: string;
  keySource: string;
  keyConfigured: boolean;
  keyLast4: string;
};

type WorkspaceDoc = {
  name: string;
  path: string;
  exists: boolean;
  content: string;
};

type ApiState = {
  config: JsonValue;
  secrets: Record<string, { configured: boolean; last4: string; mask: string }>;
  status: JsonValue;
  meta: { configPath: string; projectRoot: string; workspaceDir: string; loadedAt: string };
};

const nav = [
  { id: "overview", label: "总览", icon: Gauge },
  { id: "credentials", label: "凭证与 Provider", icon: KeyRound },
  { id: "features", label: "功能矩阵", icon: Grid3X3 },
  { id: "qqbot", label: "QQBot", icon: Bot },
  { id: "media", label: "多模态", icon: Mic2 },
  { id: "skills", label: "Skills / Plugins", icon: Package },
  { id: "workspace", label: "人格与工作区", icon: FileText },
  { id: "raw", label: "Raw JSON", icon: Braces },
] as const;

const api = {
  async get<T>(url: string): Promise<T> {
    const response = await fetch(url);
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  },
  async post<T>(url: string, body: unknown): Promise<T> {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || payload.errors?.join("\n") || "请求失败");
    return payload;
  },
};

function getPath(root: JsonValue, path: string, fallback: JsonValue = "") {
  return path.split(".").reduce((current, part) => current?.[part], root) ?? fallback;
}

function setPath(root: JsonValue, path: string, value: JsonValue) {
  const next = structuredClone(root ?? {});
  const parts = path.split(".");
  let current = next;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i];
    if (!current[part] || typeof current[part] !== "object") current[part] = {};
    current = current[part];
  }
  current[parts.at(-1)!] = value;
  return next;
}

function setCsv(root: JsonValue, path: string, value: string) {
  return setPath(root, path, value.split(",").map((item) => item.trim()).filter(Boolean));
}

function asCsv(value: JsonValue) {
  return Array.isArray(value) ? value.join(", ") : "";
}

function formatJson(value: JsonValue) {
  return JSON.stringify(value ?? {}, null, 2);
}

function StatusPill({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return <span className={ok ? "pill ok" : "pill warn"}>{children}</span>;
}

function TextField({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
}: {
  label: string;
  value: string | number;
  onChange: (value: string) => void;
  type?: string;
  placeholder?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input type={type} value={value ?? ""} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function SecretField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input className="secret" value={value ?? ""} onChange={(event) => onChange(event.target.value)} placeholder="留空可清除；不改则保留原值" />
    </label>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

function Card({ title, children, aside }: { title: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section className="panel">
      <div className="panel-title">
        <h2>{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

function JsonField({ value, onChange }: { value: JsonValue; onChange: (value: JsonValue) => void }) {
  const [text, setText] = useState(formatJson(value));
  const [error, setError] = useState("");

  useEffect(() => {
    setText(formatJson(value));
    setError("");
  }, [value]);

  function commit() {
    try {
      onChange(JSON.parse(text || "{}"));
      setError("");
    } catch (parseError) {
      setError(parseError instanceof Error ? parseError.message : "JSON 解析失败");
    }
  }

  return (
    <>
      <textarea className="json-small" value={text} onChange={(event) => setText(event.target.value)} onBlur={commit} spellCheck={false} />
      {error ? <p className="inline-error">{error}</p> : null}
    </>
  );
}

export default function App() {
  const [active, setActive] = useState<(typeof nav)[number]["id"]>("overview");
  const [data, setData] = useState<ApiState | null>(null);
  const [config, setConfig] = useState<JsonValue>(null);
  const [features, setFeatures] = useState<Feature[]>([]);
  const [docs, setDocs] = useState<WorkspaceDoc[]>([]);
  const [selectedDoc, setSelectedDoc] = useState("IDENTITY.md");
  const [raw, setRaw] = useState("{}");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    setBusy(true);
    try {
      const configResult = await api.get<ApiState>("/api/config");
      const featureResult = await api.get<{ features: Feature[] }>("/api/feature-map");
      const docsResult = await api.get<{ docs: WorkspaceDoc[] }>("/api/workspace-docs");
      setData(configResult);
      setConfig(configResult.config);
      setRaw(formatJson(configResult.config));
      setFeatures(featureResult.features);
      setDocs(docsResult.docs);
      setMessage("配置已加载");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (active !== "raw") setRaw(formatJson(config));
  }, [active, config]);

  const providerIds = useMemo(() => Object.keys(config?.models?.providers ?? {}), [config]);
  const skillIds = useMemo(() => Object.keys(config?.skills?.entries ?? {}), [config]);
  const pluginIds = useMemo(() => Object.keys(config?.plugins?.entries ?? {}), [config]);
  const currentDoc = docs.find((doc) => doc.name === selectedDoc) ?? docs[0];

  function update(path: string, value: JsonValue) {
    setConfig((current: JsonValue) => setPath(current, path, value));
  }

  async function validateCurrent() {
    setBusy(true);
    try {
      const payload = active === "raw" ? { config: JSON.parse(raw) } : { config };
      const result = await api.post<{ ok: boolean; errors: string[]; warnings: string[] }>("/api/config/validate", payload);
      setMessage(result.ok ? `校验通过${result.warnings.length ? `，警告 ${result.warnings.length} 条` : ""}` : result.errors.join("\n"));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function saveCurrent() {
    setBusy(true);
    try {
      const payload = active === "raw" ? { config: JSON.parse(raw) } : { config };
      const result = await api.post<{ saved: boolean; backupPath?: string; errors?: string[] }>("/api/config", payload);
      setMessage(result.saved ? `已保存，备份：${result.backupPath}` : result.errors?.join("\n") ?? "保存失败");
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function saveDoc() {
    if (!currentDoc) return;
    setBusy(true);
    try {
      await api.post("/api/workspace-docs", { name: currentDoc.name, content: currentDoc.content });
      setMessage(`${currentDoc.name} 已保存`);
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  if (!data || !config) {
    return <main className="loading">正在加载 Asuka 设置中心...</main>;
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <Sparkles size={22} />
          <div>
            <strong>Asuka</strong>
            <span>本地设置中心</span>
          </div>
        </div>
        <nav>
          {nav.map((item) => {
            const Icon = item.icon;
            return (
              <button key={item.id} className={active === item.id ? "active" : ""} onClick={() => setActive(item.id)}>
                <Icon size={18} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
      </aside>

      <main className="content">
        <header className="topbar">
          <div>
            <p className="eyebrow">localhost · {data.meta.configPath}</p>
            <h1>{nav.find((item) => item.id === active)?.label}</h1>
          </div>
          <div className="actions">
            <button className="ghost" onClick={load} disabled={busy}><RefreshCw size={16} />刷新</button>
            <button className="ghost" onClick={validateCurrent} disabled={busy}><ShieldCheck size={16} />校验</button>
            <button className="primary" onClick={saveCurrent} disabled={busy}><Save size={16} />保存配置</button>
          </div>
        </header>

        {message && <div className="notice">{message}</div>}

        {active === "overview" && (
          <div className="grid two">
            <Card title="运行状态">
              <div className="metric-list">
                <div><span>Gateway</span><StatusPill ok={data.status.gateway.configured}>{data.status.gateway.bind || "未指定"}:{data.status.gateway.port || "未指定"}</StatusPill></div>
                <div><span>QQBot</span><StatusPill ok={data.status.qqbot.appIdConfigured && data.status.qqbot.clientSecretConfigured}>appId / secret</StatusPill></div>
                <div><span>Gateway Token</span><StatusPill ok={data.status.gateway.tokenConfigured}>auth.token</StatusPill></div>
                <div><span>配置文件</span><code>{data.meta.configPath}</code></div>
              </div>
            </Card>
            <Card title="Provider 概览">
              <div className="provider-list">
                {data.status.providers.map((provider: JsonValue) => (
                  <div className="provider-row" key={provider.id}>
                    <strong>{provider.id}</strong>
                    <span>{provider.baseUrl || "未配置 baseUrl"}</span>
                    <StatusPill ok={provider.configured}>{provider.configured ? "key 已配置" : "key 缺失"}</StatusPill>
                  </div>
                ))}
              </div>
            </Card>
            <Card title="功能就绪度" aside={<CheckCircle2 size={18} />}>
              <div className="readiness">
                {features.map((feature) => (
                  <div key={feature.name}>
                    <span>{feature.name}</span>
                    <StatusPill ok={feature.enabled && feature.keyConfigured}>{feature.enabled ? (feature.keyConfigured ? "就绪" : "缺 key") : "关闭"}</StatusPill>
                  </div>
                ))}
              </div>
            </Card>
            <Card title="密钥策略">
              <p className="plain">敏感字段只显示掩码。保存时未修改的掩码会保留原值，输入空值会清除该 secret，输入新值才会覆盖。</p>
            </Card>
          </div>
        )}

        {active === "credentials" && (
          <div className="stack">
            <Card title="模型 Provider">
              <div className="grid two">
                {providerIds.map((id) => {
                  const base = `models.providers.${id}`;
                  return (
                    <div className="subpanel" key={id}>
                      <h3>{id}</h3>
                      <TextField label="baseUrl" value={getPath(config, `${base}.baseUrl`)} onChange={(value) => update(`${base}.baseUrl`, value)} />
                      <TextField label="api" value={getPath(config, `${base}.api`)} onChange={(value) => update(`${base}.api`, value)} />
                      <SecretField label="apiKey / oauthKey" value={getPath(config, `${base}.apiKey`)} onChange={(value) => update(`${base}.apiKey`, value)} />
                      <TextField label="默认模型 ID" value={getPath(config, `${base}.models.0.id`)} onChange={(value) => update(`${base}.models.0.id`, value)} />
                      <TextField label="默认模型名称" value={getPath(config, `${base}.models.0.name`)} onChange={(value) => update(`${base}.models.0.name`, value)} />
                    </div>
                  );
                })}
              </div>
            </Card>
            <Card title="系统密钥">
              <div className="grid two">
                <SecretField label="QQBot clientSecret" value={getPath(config, "channels.qqbot.clientSecret")} onChange={(value) => update("channels.qqbot.clientSecret", value)} />
                <SecretField label="Gateway auth.token" value={getPath(config, "gateway.auth.token")} onChange={(value) => update("gateway.auth.token", value)} />
                <SecretField label="asuka-selfie STUDIO_API_KEY" value={getPath(config, "skills.entries.asuka-selfie.env.STUDIO_API_KEY")} onChange={(value) => update("skills.entries.asuka-selfie.env.STUDIO_API_KEY", value)} />
                <TextField label="asuka-selfie STUDIO_AUTH_PROFILE" value={getPath(config, "skills.entries.asuka-selfie.env.STUDIO_AUTH_PROFILE")} onChange={(value) => update("skills.entries.asuka-selfie.env.STUDIO_AUTH_PROFILE", value)} />
                <SecretField label="asuka-selfie apiKey" value={getPath(config, "skills.entries.asuka-selfie.apiKey")} onChange={(value) => update("skills.entries.asuka-selfie.apiKey", value)} />
              </div>
            </Card>
          </div>
        )}

        {active === "features" && (
          <Card title="功能到凭证映射">
            <table>
              <thead>
                <tr>
                  <th>功能</th>
                  <th>Provider</th>
                  <th>Model / App</th>
                  <th>Key 来源</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {features.map((feature) => (
                  <tr key={feature.name}>
                    <td>{feature.name}</td>
                    <td>{feature.provider}</td>
                    <td><code>{feature.model}</code></td>
                    <td><code>{feature.keySource}</code>{feature.keyLast4 ? <span className="last4">尾号 {feature.keyLast4}</span> : null}</td>
                    <td><StatusPill ok={feature.enabled && feature.keyConfigured}>{feature.enabled ? (feature.keyConfigured ? "已绑定" : "缺凭证") : "关闭"}</StatusPill></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}

        {active === "qqbot" && (
          <div className="stack">
            <Card title="账号与消息">
              <div className="grid two">
                <Toggle label="启用 QQBot" checked={getPath(config, "channels.qqbot.enabled", true) !== false} onChange={(value) => update("channels.qqbot.enabled", value)} />
                <Toggle label="Markdown 支持" checked={getPath(config, "channels.qqbot.markdownSupport", true) !== false} onChange={(value) => update("channels.qqbot.markdownSupport", value)} />
                <TextField label="appId" value={getPath(config, "channels.qqbot.appId")} onChange={(value) => update("channels.qqbot.appId", value)} />
                <SecretField label="clientSecret" value={getPath(config, "channels.qqbot.clientSecret")} onChange={(value) => update("channels.qqbot.clientSecret", value)} />
                <TextField label="allowFrom（逗号分隔）" value={asCsv(getPath(config, "channels.qqbot.allowFrom", []))} onChange={(value) => setConfig((current: JsonValue) => setCsv(current, "channels.qqbot.allowFrom", value))} />
                <TextField label="imageServerBaseUrl" value={getPath(config, "channels.qqbot.imageServerBaseUrl")} onChange={(value) => update("channels.qqbot.imageServerBaseUrl", value)} />
                <TextField label="messageBufferMs" type="number" value={getPath(config, "channels.qqbot.messageBufferMs")} onChange={(value) => update("channels.qqbot.messageBufferMs", Number(value))} />
                <TextField label="messageBufferMaxMs" type="number" value={getPath(config, "channels.qqbot.messageBufferMaxMs")} onChange={(value) => update("channels.qqbot.messageBufferMaxMs", Number(value))} />
              </div>
              <label className="field wide">
                <span>systemPrompt</span>
                <textarea value={getPath(config, "channels.qqbot.systemPrompt")} onChange={(event) => update("channels.qqbot.systemPrompt", event.target.value)} />
              </label>
            </Card>
            <Card title="主动消息静默时段">
              <div className="grid four">
                <Toggle label="启用静默时段" checked={Boolean(getPath(config, "channels.qqbot.proactiveQuietHours.enabled", false))} onChange={(value) => update("channels.qqbot.proactiveQuietHours.enabled", value)} />
                <TextField label="开始小时" type="number" value={getPath(config, "channels.qqbot.proactiveQuietHours.startHour", 0)} onChange={(value) => update("channels.qqbot.proactiveQuietHours.startHour", Number(value))} />
                <TextField label="结束小时" type="number" value={getPath(config, "channels.qqbot.proactiveQuietHours.endHour", 8)} onChange={(value) => update("channels.qqbot.proactiveQuietHours.endHour", Number(value))} />
                <TextField label="timezone" value={getPath(config, "channels.qqbot.proactiveQuietHours.timezone", "Asia/Shanghai")} onChange={(value) => update("channels.qqbot.proactiveQuietHours.timezone", value)} />
              </div>
            </Card>
          </div>
        )}

        {active === "media" && (
          <div className="stack">
            <Card title="TTS / STT">
              <div className="grid two">
                <Toggle label="启用 TTS" checked={getPath(config, "channels.qqbot.tts.enabled", true) !== false} onChange={(value) => update("channels.qqbot.tts.enabled", value)} />
                <TextField label="TTS provider" value={getPath(config, "channels.qqbot.tts.provider", "minimax")} onChange={(value) => update("channels.qqbot.tts.provider", value)} />
                <TextField label="TTS model" value={getPath(config, "channels.qqbot.tts.model")} onChange={(value) => update("channels.qqbot.tts.model", value)} />
                <TextField label="voice" value={getPath(config, "channels.qqbot.tts.voice")} onChange={(value) => update("channels.qqbot.tts.voice", value)} />
                <TextField label="speed" type="number" value={getPath(config, "channels.qqbot.tts.speed", 1)} onChange={(value) => update("channels.qqbot.tts.speed", Number(value))} />
                <TextField label="maxInputChars" type="number" value={getPath(config, "channels.qqbot.tts.maxInputChars", "")} onChange={(value) => update("channels.qqbot.tts.maxInputChars", Number(value))} />
                <TextField label="STT provider" value={getPath(config, "channels.qqbot.stt.provider", "openai")} onChange={(value) => update("channels.qqbot.stt.provider", value)} />
                <TextField label="STT model" value={getPath(config, "channels.qqbot.stt.model", "whisper-1")} onChange={(value) => update("channels.qqbot.stt.model", value)} />
              </div>
            </Card>
            <Card title="MiniMax Vision / Search / Digest">
              <div className="grid three">
                <div className="subpanel">
                  <h3>Vision</h3>
                  <Toggle label="启用" checked={getPath(config, "channels.qqbot.minimax.vision.enabled", true) !== false} onChange={(value) => update("channels.qqbot.minimax.vision.enabled", value)} />
                  <TextField label="model" value={getPath(config, "channels.qqbot.minimax.vision.model")} onChange={(value) => update("channels.qqbot.minimax.vision.model", value)} />
                  <TextField label="maxImagesPerMessage" type="number" value={getPath(config, "channels.qqbot.minimax.vision.maxImagesPerMessage", "")} onChange={(value) => update("channels.qqbot.minimax.vision.maxImagesPerMessage", Number(value))} />
                </div>
                <div className="subpanel">
                  <h3>Search</h3>
                  <Toggle label="启用" checked={getPath(config, "channels.qqbot.minimax.search.enabled", true) !== false} onChange={(value) => update("channels.qqbot.minimax.search.enabled", value)} />
                  <TextField label="model" value={getPath(config, "channels.qqbot.minimax.search.model")} onChange={(value) => update("channels.qqbot.minimax.search.model", value)} />
                  <TextField label="intentModel" value={getPath(config, "channels.qqbot.minimax.search.intentModel")} onChange={(value) => update("channels.qqbot.minimax.search.intentModel", value)} />
                </div>
                <div className="subpanel">
                  <h3>Digest</h3>
                  <Toggle label="启用" checked={getPath(config, "channels.qqbot.minimax.digest.enabled", true) !== false} onChange={(value) => update("channels.qqbot.minimax.digest.enabled", value)} />
                  <TextField label="model" value={getPath(config, "channels.qqbot.minimax.digest.model")} onChange={(value) => update("channels.qqbot.minimax.digest.model", value)} />
                  <TextField label="maxDigestChars" type="number" value={getPath(config, "channels.qqbot.minimax.digest.maxDigestChars", "")} onChange={(value) => update("channels.qqbot.minimax.digest.maxDigestChars", Number(value))} />
                </div>
              </div>
            </Card>
            <Card title="Asuka 自拍">
              <div className="grid two">
                <Toggle label="启用 asuka-selfie" checked={getPath(config, "skills.entries.asuka-selfie.enabled", true) !== false} onChange={(value) => update("skills.entries.asuka-selfie.enabled", value)} />
                <SecretField label="STUDIO_API_KEY" value={getPath(config, "skills.entries.asuka-selfie.env.STUDIO_API_KEY")} onChange={(value) => update("skills.entries.asuka-selfie.env.STUDIO_API_KEY", value)} />
                <TextField label="STUDIO_AUTH_PROFILE" value={getPath(config, "skills.entries.asuka-selfie.env.STUDIO_AUTH_PROFILE")} onChange={(value) => update("skills.entries.asuka-selfie.env.STUDIO_AUTH_PROFILE", value)} />
                <TextField label="STUDIO_API_BASE_URL" value={getPath(config, "skills.entries.asuka-selfie.env.STUDIO_API_BASE_URL")} onChange={(value) => update("skills.entries.asuka-selfie.env.STUDIO_API_BASE_URL", value)} />
                <TextField label="STUDIO_IMAGE_MODEL" value={getPath(config, "skills.entries.asuka-selfie.env.STUDIO_IMAGE_MODEL")} onChange={(value) => update("skills.entries.asuka-selfie.env.STUDIO_IMAGE_MODEL", value)} />
                <TextField label="STUDIO_IMAGE_QUALITY" value={getPath(config, "skills.entries.asuka-selfie.env.STUDIO_IMAGE_QUALITY")} onChange={(value) => update("skills.entries.asuka-selfie.env.STUDIO_IMAGE_QUALITY", value)} />
                <TextField label="ASUKA_REFERENCE_IMAGE_PATH" value={getPath(config, "skills.entries.asuka-selfie.env.ASUKA_REFERENCE_IMAGE_PATH")} onChange={(value) => update("skills.entries.asuka-selfie.env.ASUKA_REFERENCE_IMAGE_PATH", value)} />
              </div>
            </Card>
          </div>
        )}

        {active === "skills" && (
          <div className="grid two">
            <Card title="Skills">
              {skillIds.map((id) => (
                <div className="subpanel" key={id}>
                  <h3>{id}</h3>
                  <Toggle label="启用" checked={getPath(config, `skills.entries.${id}.enabled`, true) !== false} onChange={(value) => update(`skills.entries.${id}.enabled`, value)} />
                  <SecretField label="apiKey" value={getPath(config, `skills.entries.${id}.apiKey`)} onChange={(value) => update(`skills.entries.${id}.apiKey`, value)} />
                  <JsonField value={getPath(config, `skills.entries.${id}.env`, {})} onChange={(value) => update(`skills.entries.${id}.env`, value)} />
                </div>
              ))}
            </Card>
            <Card title="Plugins">
              {pluginIds.map((id) => (
                <div className="subpanel" key={id}>
                  <h3>{id}</h3>
                  <Toggle label="启用" checked={getPath(config, `plugins.entries.${id}.enabled`, true) !== false} onChange={(value) => update(`plugins.entries.${id}.enabled`, value)} />
                </div>
              ))}
              <TextField label="plugins.allow（逗号分隔）" value={asCsv(getPath(config, "plugins.allow", []))} onChange={(value) => setConfig((current: JsonValue) => setCsv(current, "plugins.allow", value))} />
            </Card>
          </div>
        )}

        {active === "workspace" && (
          <Card title="工作区文档">
            <div className="doc-tabs">
              {docs.map((doc) => (
                <button key={doc.name} className={selectedDoc === doc.name ? "active" : ""} onClick={() => setSelectedDoc(doc.name)}>{doc.name}</button>
              ))}
            </div>
            {currentDoc && (
              <>
                <p className="pathline">{currentDoc.path}</p>
                <textarea className="doc-editor" value={currentDoc.content} onChange={(event) => setDocs((items) => items.map((item) => item.name === currentDoc.name ? { ...item, content: event.target.value } : item))} />
                <button className="primary doc-save" onClick={saveDoc} disabled={busy}><Save size={16} />保存文档</button>
              </>
            )}
          </Card>
        )}

        {active === "raw" && (
          <Card title="Raw JSON">
            <textarea className="raw-editor" value={raw} onChange={(event) => setRaw(event.target.value)} spellCheck={false} />
          </Card>
        )}
      </main>
    </div>
  );
}
