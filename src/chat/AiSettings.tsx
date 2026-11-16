import { appName } from "../appName";
import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { Cpu, Plus, ShieldAlert, SlidersHorizontal } from "lucide-react";
import { ModalDialog } from "../files/Dialog";
import { settingsDocumentTitle, type AiTab } from "../router";
import { AI_TAB_LABELS } from "../settings/hubModel";
import { SettingsTabs, settingsTabIds, type SettingsTab } from "../settings/SettingsTabs";
import { Select } from "../ui/Select";
import { useConfirm } from "../ui/useConfirm";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";
import { AGENT_BOUNDS, AGENT_ROLE_OPTIONS, DEFAULT_BASE_URL, DEFAULT_COMPAT, DEFAULT_MODEL, FLAVOR_LABELS, flavorDefaults, normalizeKnownBaseUrl, providerChats, providerEmbeds, providerFlavor, REASONING_EFFORTS, type AgentRole, type CompatFlavor, type ProviderCompat, type ProviderFlavor, type ReasoningEffort, type AgentSettings, type ProviderSummary } from "../../shared/agents";
import { agentsStatus, createProvider, deleteProvider, listProviders, messageOf, probeProviderTools, readSettings, testProvider, updateProvider, writeSettings, errorCode, type AgentsStatus, type ProviderInput, type ProviderTest } from "./chatApi";
import type { ToolCallingProbe } from "../../shared/reportsModel";
import { ToolServersSection } from "./ToolServers";
import { AiUsage } from "./AiUsage";
import { policyDraft, policyFromDraft, policySummary, ProviderKnowledgeFields } from "./ProviderKnowledgePolicy";
import { ProviderVisionFields, visionDraft, visionFromDraft, visionSummary } from "./ProviderVisionPolicy";
import { HUB_TITLE_ID } from "../settings/hubModel";
import "./chat.css";
import { notify } from "../ui/notify";
import { FormError } from "../ui/FormError";
import { LOCAL_BASE_URL, LOCAL_MODEL, LOCAL_MODEL_BYTES, type LocalEmbeddingStatus } from "../../shared/localEmbedding";

/**
 * Settings → AI (admins; agent chat plan §4.1, §13.4): providers (name, base URL, a write-only API
 * key shown as a hint, default model, compatibility) with Test, and the chat policy (who creates,
 * who chats, daily token budgets). Without AGENT_SECRETS_KEY the page explains what to set and
 * everything else is disabled.
 */

export const SECRET_HONESTY = "Encrypted at rest; anyone with the server and its key can read these secrets.";
const ROLE_LABELS: Record<AgentRole, string> = { admin: "Admins", member: "Members", viewer: "Viewers" };

/**
 * Tabs (each its own URL): Model providers, Tool servers, Chat policy, Usage (D1381). `tabs` are the ones the
 * role sees (hubModel's aiTabsFor) and `tab` the one on screen; `onSelectTab` navigates.
 */
export function AiSettings({ flash, tabs, tab, onSelectTab }: { flash: (message: string) => void; tabs: readonly AiTab[]; tab: AiTab; onSelectTab: (tab: AiTab) => void }) {
  const [status, setStatus] = useState<AgentsStatus | null>(null);
  const [serverCount, setServerCount] = useState<number | null>(null);
  const [providers, setProviders] = useState<ProviderSummary[] | null>(null);
  const [local, setLocal] = useState<LocalEmbeddingStatus | null>(null);
  const [settings, setSettings] = useState<(AgentSettings & { revision: number }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<ProviderSummary | "new" | null>(null);
  const [tests, setTests] = useState<Record<string, ProviderTest | "running">>({});
  const [probes, setProbes] = useState<Record<string, ToolCallingProbe | "running">>({});
  // D1381: Usage loads the first time its tab is shown, then stays mounted like the others.
  const [usageShown, setUsageShown] = useState(tab === "usage");
  useEffect(() => { if (tab === "usage") setUsageShown(true); }, [tab]);
  const confirm = useConfirm();
  // One title per tab, as API keys' tabs (v0.31 follow-up): "Settings · AI · Model providers · Nook". The page loads lazily, after App set it.
  useEffect(() => { document.title = settingsDocumentTitle("ai", undefined, tab); }, [tab]);

  const load = useCallback(async () => {
    try {
      const next = await agentsStatus();
      setStatus(next);
      if (!next.enabled) return;
      const [list, policy] = await Promise.all([listProviders(), readSettings()]);
      setProviders(list.providers);
      setLocal(list.local ?? null);
      setSettings(policy.settings);
      setError(null);
    } catch (reason) {
      setError(messageOf(reason, "Could not load AI settings"));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function test(provider: ProviderSummary) {
    setTests((current) => ({ ...current, [provider.id]: "running" }));
    try {
      const { test: result } = await testProvider(provider.id);
      setTests((current) => ({ ...current, [provider.id]: result }));
    } catch (reason) {
      notify.error(messageOf(reason, "The test could not run"));
      setTests((current) => { const next = { ...current }; delete next[provider.id]; return next; });
    }
  }
  /** Wave 48b: probes `required` and named tool choice and stores the answer in the provider's compat flags. */
  async function probeTools(provider: ProviderSummary) {
    setProbes((current) => ({ ...current, [provider.id]: "running" }));
    try {
      const { probe, provider: saved } = await probeProviderTools(provider.id);
      setProbes((current) => ({ ...current, [provider.id]: probe }));
      setProviders((current) => current?.map((item) => item.id === saved.id ? saved : item) ?? current);
    } catch (reason) {
      notify.error(messageOf(reason, "The tool-calling test could not run"));
      setProbes((current) => { const next = { ...current }; delete next[provider.id]; return next; });
    }
  }
  async function remove(provider: ProviderSummary) {
    if (!await confirm.ask({ title: `Remove ${provider.name}?`, message: "Agents using it fall back to the default provider. Its API key is deleted.", confirmLabel: "Remove", danger: true })) return;
    try {
      await deleteProvider(provider.id);
      notify.success("Provider removed");
      void load();
    } catch (reason) {
      notify.error(messageOf(reason, "Could not remove the provider"));
    }
  }
  async function makeDefault(provider: ProviderSummary) {
    try {
      await updateProvider(provider.id, { isDefault: true, expectedRevision: provider.revision });
      void load();
    } catch (reason) {
      notify.error(messageOf(reason, "Could not change the default"));
    }
  }

  if (error) return <section className="settings-content" aria-labelledby={HUB_TITLE_ID}><p className="form-error" role="alert">{error}</p><button className="secondary-button" onClick={() => { void load(); }}>Retry</button></section>;
  if (!status) return <section className="settings-content" aria-busy="true"><p className="chat-muted">Loading…</p></section>;
  if (!status.enabled) {
    return <section className="settings-content ai-settings" aria-labelledby={HUB_TITLE_ID}>
      <div className="settings-section-heading"><span className="settings-icon"><Cpu /></span><div><p>Model providers and the chat policy.</p></div></div>
      <div className="settings-warning"><ShieldAlert />{status.reason === "key_mismatch" ? "AGENT_SECRETS_KEY does not open the stored provider secrets." : "AGENT_SECRETS_KEY is not set, so Chat is off."}</div>
      <div className="security-card setup-intro">
        <strong>Not configured</strong>
        <p>{status.reason === "key_mismatch" ? "Restore the key the providers were saved with, or remove and re-enter their API keys." : "Generate a key with openssl rand -base64 32 (different from TOTP_ENCRYPTION_KEY and VAULT_ENCRYPTION_KEY), set it as AGENT_SECRETS_KEY or AGENT_SECRETS_KEY_FILE on the server, and restart. Then come back here to add a model provider."} See docs/OPERATIONS.md, Agent chat.</p>
      </div>
    </section>;
  }
  const tabRow: Array<SettingsTab<AiTab>> = tabs.map((id) => ({
    id,
    label: AI_TAB_LABELS[id],
    ...(id === "providers" && providers ? { count: providers.length, countNoun: "provider" } : {}),
    ...(id === "tools" && serverCount !== null ? { count: serverCount, countNoun: "tool server" } : {})
  }));
  // Every tab stays mounted (hidden when not selected): an unsaved policy edit survives a tab switch, and the tool server count stays live.
  const panel = (id: AiTab) => ({ role: "tabpanel", id: settingsTabIds("ai", id).panel, "aria-labelledby": settingsTabIds("ai", id).tab, hidden: id !== tab, className: "settings-tab-panel" });
  return <section className="settings-content ai-settings" aria-label="AI">
    <SettingsTabs label="AI settings" idPrefix="ai" tabs={tabRow} selected={tab} onSelect={onSelectTab} />
    {tabs.includes("providers") && <div {...panel("providers")}>
    <div className="settings-section-heading"><span className="settings-icon"><Cpu /></span><div><h3 id="ai-heading">Model providers</h3><p>OpenAI-compatible endpoints the server calls for every chat. Every message, prompt, and reply leaves this Nook for the provider you configure. At most {AGENT_BOUNDS.providers}; one is the default.</p></div></div>
    <ul className="ai-providers">
      {providers?.map((provider) => {
        const result = tests[provider.id];
        const probe = probes[provider.id];
        // D542: an embeddings-only provider (Voyage AI) is never a chat model: no tool test, no default, no chat facts.
        const chats = providerChats(provider.compat);
        const embeds = providerEmbeds(provider.compat);
        return <li key={provider.id} className="security-card ai-provider">
          <div className="ai-provider-head">
            <div><span className="ai-provider-name"><strong>{provider.name}</strong>{provider.isDefault && <span className="ai-badge">Default</span>}</span><small>{isLocal(provider) ? "Runs inside this Nook; nothing leaves the server" : provider.baseUrl}</small></div>
            <div className="ai-provider-actions">
              <button type="button" className="secondary-button" onClick={() => { void test(provider); }} disabled={result === "running"}>{result === "running" ? "Testing…" : "Test"}</button>
              {chats && <button type="button" className="secondary-button" onClick={() => { void probeTools(provider); }} disabled={probe === "running"}>{probe === "running" ? "Testing tools…" : "Test tool calling"}</button>}
              <button type="button" className="secondary-button" onClick={() => setEditing(provider)}>Edit</button>
              {!provider.isDefault && chats && <button type="button" className="secondary-button" onClick={() => { void makeDefault(provider); }}>Make default</button>}
              <button type="button" className="secondary-button" onClick={() => { void remove(provider); }}>Remove</button>
            </div>
          </div>
          <dl className="ai-provider-facts">
            <div><dt>Endpoint</dt><dd>{endpointLabel(provider)}</dd></div>
            <div><dt>Capabilities</dt><dd>{capabilitiesSummary(provider.compat)}</dd></div>
            {!isLocal(provider) && <div><dt>API key</dt><dd>{provider.hasSecret ? <code>{provider.hint ?? "Saved"}</code> : <span className="chat-muted">none</span>}</dd></div>}
            {chats && <div><dt>Default model</dt><dd><code>{provider.defaultModel}</code></dd></div>}
            {chats && <div><dt>Token parameter</dt><dd><code>{breakable(provider.compat.tokenParam)}</code></dd></div>}
            {chats && <div><dt>Context</dt><dd>{provider.compat.contextTokens.toLocaleString()} tokens{provider.compat.streamUsage ? "" : " · usage estimated"}</dd></div>}
            {embeds && <div><dt>Knowledge bases</dt><dd>{isLocal(provider) ? (provider.knowledge.enabled ? "Allowed" : "Not allowed") : policySummary(provider.knowledge)}</dd></div>}
            {embeds && provider.embeddingModel && <div><dt>Embedding model</dt><dd><code>{breakable(provider.embeddingModel)}</code>{provider.compat.embeddingSizes ? ` · ${provider.compat.embeddingSizes.map((size) => size.toLocaleString("en-US")).join(", ")} dimensions` : provider.embeddingDims ? ` · ${provider.embeddingDims.toLocaleString("en-US")} dimensions` : ""}</dd></div>}
            {chats && <div><dt>Images</dt><dd>{visionSummary(provider.vision)}</dd></div>}
            {chats && <div><dt>Tool choice</dt><dd>{toolChoiceSummary(provider.compat)}</dd></div>}
            {chats && provider.compat.reasoningEffort && <div><dt>Reasoning effort</dt><dd><code>{provider.compat.reasoningEffort}</code></dd></div>}
          </dl>
          {result && result !== "running" && <p className={`ai-test ${result.ok ? "ok" : "failed"}`} role="status">{testText(result)}</p>}
          {probe && probe !== "running" && <p className={`ai-test ${probe.toolCalling === "forced" || probe.toolCalling === "auto" || (probe.toolCalling === undefined && probe.compat.requiredToolChoice && probe.compat.namedToolChoice) ? "ok" : "failed"}`} role="status">{probeSummary(probe)}</p>}
        </li>;
      })}
    </ul>
    {providers && providers.length === 0 && <p className="chat-muted">No provider yet. Chats need one.</p>}
    <p className="policy-copy">{SECRET_HONESTY}</p>
    <button type="button" className="action-button secondary ai-add" onClick={() => setEditing("new")} disabled={(providers?.length ?? 0) >= AGENT_BOUNDS.providers}><Plus />Add provider</button>
    </div>}
    {tabs.includes("tools") && <div {...panel("tools")}><ToolServersSection flash={flash} onCountChange={setServerCount} /></div>}
    {tabs.includes("policy") && <div {...panel("policy")}>
      <div className="settings-section-heading"><span className="settings-icon"><SlidersHorizontal /></span><div><h3 id="ai-policy-heading">Chat policy</h3><p>Who creates agents, who chats, daily token budgets, and the default provider.</p></div></div>
      {settings && <PolicyForm settings={settings} providers={providers ?? []} flash={flash} onSaved={(next) => setSettings(next)} />}
    </div>}
    {tabs.includes("usage") && <div {...panel("usage")}>{usageShown && <AiUsage />}</div>}
    {editing && <ProviderDialog provider={editing === "new" ? null : editing} local={local} onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />}
    {confirm.confirmElement}
  </section>;
}

function PolicyForm({ settings, providers, flash, onSaved }: { settings: AgentSettings & { revision: number }; providers: ProviderSummary[]; flash: (message: string) => void; onSaved: (settings: AgentSettings & { revision: number }) => void }) {
  const [draft, setDraft] = useState(settings);
  const [busy, setBusy] = useState(false);
  useEffect(() => setDraft(settings), [settings]);
  // D542: chats and reports go only to providers that answer chat.
  const chatProviders = providers.filter((provider) => providerChats(provider.compat));
  const toggleRole = (field: "createRoles" | "chatRoles", role: AgentRole) => setDraft((current) => ({ ...current, [field]: current[field].includes(role) ? current[field].filter((item) => item !== role) : [...current[field], role] }));
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const { settings: next } = await writeSettings({ createRoles: draft.createRoles, chatRoles: draft.chatRoles, dailyTokensUser: draft.dailyTokensUser, dailyTokensInstance: draft.dailyTokensInstance, agentsPerUser: draft.agentsPerUser, defaultProviderId: draft.defaultProviderId, publicChatLinks: draft.publicChatLinks,
        reportProviderId: draft.reportProviderId, reportModel: draft.reportModel?.trim() || null, reportModelFreeText: draft.reportModelFreeText,
        reportFallbackProviderId: draft.reportFallbackProviderId, reportFallbackModel: draft.reportFallbackProviderId ? draft.reportFallbackModel?.trim() || null : null, nookAutoTools: draft.nookAutoTools, expectedRevision: settings.revision });
      onSaved(next);
      notify.success("Policy saved");
    } catch (reason) {
      notify.error(errorCode(reason) === "REVISION_MISMATCH" ? "The policy changed elsewhere; reload and try again" : messageOf(reason, "Could not save the policy"));
    } finally {
      setBusy(false);
    }
  }
  const roleBoxes = (field: "createRoles" | "chatRoles") => <div className="ai-roles">{AGENT_ROLE_OPTIONS.map((role) => <label key={role}><input type="checkbox" checked={draft[field].includes(role)} onChange={() => toggleRole(field, role)} />{ROLE_LABELS[role]}</label>)}</div>;
  return <form className="security-card ai-policy" onSubmit={save} aria-labelledby="ai-policy-heading" noValidate>
    <p>Guests never see Chat. Budgets reset at midnight UTC; a run is refused before it starts once the budget is used up.</p>
    <div className="ai-policy-grid">
      <div><span className="ai-label">Who can create agents</span>{roleBoxes("createRoles")}</div>
      <div><span className="ai-label">Who can chat</span>{roleBoxes("chatRoles")}</div>
      <label>Tokens per person per day<input type="number" min={0} max={1_000_000_000} value={draft.dailyTokensUser} onChange={(event) => setDraft({ ...draft, dailyTokensUser: Math.max(0, Math.floor(Number(event.target.value) || 0)) })} /><small>0 = unlimited</small></label>
      <label>Tokens for the whole Nook per day<input type="number" min={0} max={10_000_000_000} value={draft.dailyTokensInstance} onChange={(event) => setDraft({ ...draft, dailyTokensInstance: Math.max(0, Math.floor(Number(event.target.value) || 0)) })} /><small>0 = unlimited</small></label>
      <label>Agents per person<input type="number" min={1} max={500} value={draft.agentsPerUser} onChange={(event) => setDraft({ ...draft, agentsPerUser: Math.min(500, Math.max(1, Math.floor(Number(event.target.value) || 1))) })} /></label>
      <div><span className="ai-label" id="ai-default-provider">Default provider</span><Select<string> labelledBy="ai-default-provider" label="Default provider" value={draft.defaultProviderId ?? providers.find((provider) => provider.isDefault)?.id ?? null} onChange={(value) => setDraft({ ...draft, defaultProviderId: value })} options={chatProviders.map((provider) => ({ value: provider.id, label: provider.name, description: provider.defaultModel }))} placeholder="The provider marked default" disabled={chatProviders.length === 0} /></div>
    </div>
    <fieldset className="ai-report-model">
      <legend className="ai-label">Report generation model</legend>
      <p className="chat-muted">The provider and model that write analytics reports. Chat keeps its default; a report's owner may choose another for one report.</p>
      <div className="ai-policy-grid">
        <div><span className="ai-label" id="ai-report-provider">Provider</span><Select<string> labelledBy="ai-report-provider" label="Report generation provider" value={draft.reportProviderId ?? ""} onChange={(value) => setDraft({ ...draft, reportProviderId: value || null })} options={[{ value: "", label: "Chat's default provider" }, ...chatProviders.map((provider) => ({ value: provider.id, label: provider.name, description: provider.defaultModel }))]} disabled={chatProviders.length === 0} /></div>
        <label>Model<input value={draft.reportModel ?? ""} maxLength={AGENT_BOUNDS.model} placeholder="The provider's default model" autoComplete="off" onChange={(event) => setDraft({ ...draft, reportModel: event.target.value || null })} /><small>For example glm-5.3; empty uses the provider's default</small></label>
      </div>
      <label className="ai-check"><input type="checkbox" checked={draft.reportModelFreeText} onChange={(event) => setDraft({ ...draft, reportModelFreeText: event.target.checked })} />Report owners may type any model name</label>
      <p className="chat-muted">Off: an owner picks from the provider's listed models (seen by Test or the model list), its default, or the report model above.</p>
    </fieldset>
    <fieldset className="ai-report-model">
      <legend className="ai-label">Fallback model for reports</legend>
      <p className="chat-muted">When a report's model uses up its tries or nudges without saving a report, the generation is retried once on this model. Each block records the model that wrote it.</p>
      <div className="ai-policy-grid">
        <div><span className="ai-label" id="ai-report-fallback-provider">Provider</span><Select<string> labelledBy="ai-report-fallback-provider" label="Fallback provider for reports" value={draft.reportFallbackProviderId ?? ""} onChange={(value) => setDraft({ ...draft, reportFallbackProviderId: value || null })} options={[{ value: "", label: "Off (no fallback)" }, ...chatProviders.map((provider) => ({ value: provider.id, label: provider.name, description: provider.defaultModel }))]} disabled={chatProviders.length === 0} /></div>
        <label>Model<input value={draft.reportFallbackModel ?? ""} maxLength={AGENT_BOUNDS.model} placeholder="The provider's default model" autoComplete="off" disabled={!draft.reportFallbackProviderId} onChange={(event) => setDraft({ ...draft, reportFallbackModel: event.target.value || null })} /><small>Empty uses the provider's default</small></label>
      </div>
    </fieldset>
    <label className="ai-check"><input type="checkbox" checked={draft.nookAutoTools} onChange={(event) => setDraft({ ...draft, nookAutoTools: event.target.checked })} />Give agents {appName()}'s tools automatically</label>
    <p className="chat-muted">{nookAutoPolicyText()}</p>
    <label className="ai-check"><input type="checkbox" checked={draft.publicChatLinks} onChange={(event) => setDraft({ ...draft, publicChatLinks: event.target.checked })} />Allow public chat links</label>
    <p className="chat-muted">{PUBLIC_LINKS_POLICY_TEXT}</p>
    <footer className="file-dialog-actions"><button type="submit" className="primary-button" disabled={busy}>{busy ? "Saving…" : "Save policy"}</button></footer>
  </form>;
}

/** What the automatic Nook tools do (C2), under the admin's checkbox. */
export const nookAutoPolicyText = () => `Each person's agents read what that person can read in ${appName()}, and suggest changes as Inbox proposals they approve; nothing is changed directly. No key to link: ${appName()} keeps an internal key per person that works only inside ${appName()}. Bin, keys, the Vault, uploads, and report queries stay out. Each agent can turn this off, and a linked key with direct writes still works as before.`;

/** What the public-links policy does (Wave 43, AC-O1, D362), under its checkbox. */
export const PUBLIC_LINKS_POLICY_TEXT = "Members and admins can then publish a frozen snapshot of one of their chats at a link anyone can open without signing in; tool results stay hidden unless they include them. Turning this off makes every link answer “not found” at once; the links are kept, so they work again if you turn it back on.";

function ProviderDialog({ provider, local, onCancel, onSaved }: { provider: ProviderSummary | null; local: LocalEmbeddingStatus | null; onCancel: () => void; onSaved: () => void }) {
  // D544: what is added: an endpoint (OpenAI-compatible, Anthropic, Voyage AI), or the model built into Nook. An existing provider keeps its kind.
  const [kind, setKind] = useState<"endpoint" | "local">(provider && isLocal(provider) ? "local" : "endpoint");
  const [name, setName] = useState(provider?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? DEFAULT_BASE_URL);
  const [apiKey, setApiKey] = useState("");
  const [removeSecret, setRemoveSecret] = useState(false);
  // Empty for a new provider: the placeholder shows the default and an empty field saves it (QA Q8: a pre-filled value under the same placeholder read as a hint and got typed over).
  const [defaultModel, setDefaultModel] = useState(provider?.defaultModel ?? "");
  const [tokenParam, setTokenParam] = useState<"max_completion_tokens" | "max_tokens">(provider?.compat.tokenParam ?? "max_completion_tokens");
  const [streamUsage, setStreamUsage] = useState(provider?.compat.streamUsage ?? true);
  const [contextTokens, setContextTokens] = useState(provider?.compat.contextTokens ?? 128_000);
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>(provider?.compat.reasoningEffort ?? "omit");
  // D539–D542: what the provider can do, and Anthropic's headers for a proxy (the host decides for api.anthropic.com).
  const [chat, setChat] = useState(provider ? providerChats(provider.compat) : true);
  const [embeddings, setEmbeddings] = useState(provider ? providerEmbeds(provider.compat) : true);
  // D685: a proxy's kind (OpenAI-compatible, Anthropic, Voyage AI) and an OpenAI-compatible endpoint's size field, in Advanced.
  const [kindChoice, setKindChoice] = useState<EndpointKind>(provider?.compat.flavor ?? "openai");
  const [dimensionsParam, setDimensionsParam] = useState<SizeParam>(provider?.compat.dimensionsParam ?? "dimensions");
  // A new provider follows the host's defaults until the admin changes a field they set.
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const touch = (field: string) => setTouched((current) => current.has(field) ? current : new Set(current).add(field));
  const detected = providerFlavor(normalizeKnownBaseUrl(baseUrl));
  // The kind Nook will treat the endpoint as: its host first, else the Advanced choice.
  const effectiveKind = detected ?? (kindChoice === "openai" ? null : kindChoice);
  function applyDefaults(flavor: ProviderFlavor | null) {
    const defaults = { ...DEFAULT_COMPAT, ...flavorDefaults(flavor) };
    if (!touched.has("tokenParam")) setTokenParam(defaults.tokenParam);
    if (!touched.has("contextTokens")) setContextTokens(defaults.contextTokens);
    if (!touched.has("chat")) setChat(defaults.chat !== false);
    if (!touched.has("embeddings")) setEmbeddings(defaults.embeddings !== false);
  }
  function changeUrl(value: string) {
    setBaseUrl(value);
    if (provider) return;
    applyDefaults(providerFlavor(normalizeKnownBaseUrl(value)) ?? (kindChoice === "openai" ? null : kindChoice));
  }
  // D685: choosing a kind in Advanced moves the fields the admin has not touched to that kind's defaults (also when editing: the form shows what will be saved).
  function changeKind(value: EndpointKind) {
    setKindChoice(value);
    applyDefaults(value === "openai" ? null : value);
  }
  // A provider's own embedding model and size (API `embeddingModel`, `embeddingDims`): new knowledge bases start with them.
  const [embeddingModel, setEmbeddingModel] = useState(provider?.embeddingModel ?? "");
  const [embeddingDims, setEmbeddingDims] = useState(provider?.embeddingDims ? String(provider.embeddingDims) : "");
  const [knowledge, setKnowledge] = useState(() => policyDraft(provider?.knowledge));
  const [vision, setVision] = useState(() => visionDraft(provider?.vision));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ids = { name: useId(), url: useId(), key: useId(), model: useId(), context: useId(), param: useId(), effort: useId(), kind: useId(), embeddingModel: useId(), embeddingDims: useId(), endpointKind: useId(), sizeParam: useId() };
  useHistoryDialogGuard(true, onCancel, { blocked: busy });

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return setError("Enter a name.");
    const policy = policyFromDraft(knowledge);
    if ("error" in policy) return setError(policy.error);
    const images = visionFromDraft(vision);
    if ("error" in images) return setError(images.error);
    if (kind === "local") {
      setBusy(true);
      setError(null);
      try {
        if (provider) await updateProvider(provider.id, { name: name.trim(), knowledge: policy.policy, expectedRevision: provider.revision });
        else await createProvider({ name: name.trim(), baseUrl: LOCAL_BASE_URL, knowledge: policy.policy });
        onSaved();
      } catch (reason) {
        setError(errorCode(reason) === "REVISION_MISMATCH" ? "This provider changed elsewhere; close and reopen it." : messageOf(reason, "Could not save the provider"));
        setBusy(false);
      }
      return;
    }
    if (!chat && !embeddings) return setError("A provider must answer chat, make embeddings, or both.");
    const size = embeddingDims.trim() ? Number(embeddingDims) : null;
    if (embeddings && size !== null && (!Number.isInteger(size) || size < 64 || size > 3072)) return setError("The embedding size is a whole number from 64 to 3,072.");
    setBusy(true);
    setError(null);
    const own = embeddings ? { embeddingModel: embeddingModel.trim() || null, embeddingDims: size } : {};
    const compat = { tokenParam, streamUsage, contextTokens, reasoningEffort, chat, embeddings, ...endpointKindCompat({ detected, choice: kindChoice, dimensionsParam, embeddings, before: provider ? providerFlavor(provider.baseUrl, provider.compat) : null }) };
    try {
      if (provider) await updateProvider(provider.id, { name: name.trim(), baseUrl: baseUrl.trim(), ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}), removeSecret, defaultModel: defaultModel.trim() || DEFAULT_MODEL, ...own, compat, vision: images.policy, knowledge: policy.policy, expectedRevision: provider.revision });
      else await createProvider({ name: name.trim(), baseUrl: baseUrl.trim(), apiKey: apiKey.trim() || null, defaultModel: defaultModel.trim() || DEFAULT_MODEL, ...own, compat, vision: images.policy, knowledge: policy.policy });
      setApiKey("");
      onSaved();
    } catch (reason) {
      setError(errorCode(reason) === "REVISION_MISMATCH" ? "This provider changed elsewhere; close and reopen it." : messageOf(reason, "Could not save the provider"));
      setBusy(false);
    }
  }
  return <ModalDialog title={provider ? "Edit provider" : "Add provider"} eyebrow="AI" onClose={onCancel} busy={busy} variant="sheet" className="chat-dialog">
    <form className="file-dialog-form ai-provider-form" onSubmit={submit} noValidate>
      {!provider && <>
        <span className="ai-label" id={ids.kind}>Kind</span>
        <Select<"endpoint" | "local"> labelledBy={ids.kind} label="Kind" value={kind} onChange={(value) => { setKind(value); if (value === "local" && !name.trim()) setName("Local embeddings"); setError(null); }} options={[
          { value: "endpoint", label: "Model provider endpoint", description: "OpenAI-compatible: OpenAI, Anthropic, Voyage AI, a proxy" },
          { value: "local", label: "Local embeddings", description: localOptionText(local), disabled: !local?.allowed || !local.available || local.added }
        ]} />
        {local?.allowed && !local.available && !local.added && <p className="file-dialog-hint" role="note">Local embeddings: {local.reason}</p>}
      </>}
      <label htmlFor={ids.name}>Name</label>
      <input id={ids.name} value={name} maxLength={AGENT_BOUNDS.providerName} autoFocus autoComplete="off" placeholder={kind === "local" ? "Local embeddings" : "OpenAI"} onChange={(event) => setName(event.target.value)} />
      {kind === "local" ? <>
        <p className="file-dialog-hint">{localProviderText(local)}</p>
        {local && !local.available && <p className="settings-warning" role="note">{local.reason}</p>}
        <ProviderKnowledgeFields providerId={provider?.id ?? null} draft={knowledge} onChange={setKnowledge} disabled={busy} fixedModel />
      </> : <>
      <label htmlFor={ids.url}>Base URL</label>
      <input id={ids.url} value={baseUrl} maxLength={AGENT_BOUNDS.baseUrl} autoComplete="off" spellCheck={false} placeholder={DEFAULT_BASE_URL} onChange={(event) => changeUrl(event.target.value)} />
      <p className="file-dialog-hint">https only. A private host (Ollama, LiteLLM, vLLM on your network) must be listed in AGENT_ALLOWED_PRIVATE_HOSTS on the server.</p>
      {detected && <p className="file-dialog-hint ai-detected" role="status">{FLAVOR_HINTS[detected]}</p>}
      <label htmlFor={ids.key}>API key {provider?.hasSecret && !removeSecret ? <small>({provider.hint ? `saved: ${provider.hint}` : "saved"}; leave empty to keep it)</small> : null}</label>
      <input id={ids.key} type="password" value={apiKey} maxLength={1024} autoComplete="off" placeholder={provider?.hasSecret ? "Keep the saved key" : "sk-…"} onChange={(event) => { setApiKey(event.target.value); setRemoveSecret(false); }} />
      {provider?.hasSecret && <label className="ai-check"><input type="checkbox" checked={removeSecret} onChange={(event) => setRemoveSecret(event.target.checked)} />Remove the saved key</label>}
      <p className="file-dialog-hint">{SECRET_HONESTY} The key is sent only to this provider's endpoint and is never shown again.</p>
      <span className="ai-label">Capabilities</span>
      <label className="ai-check"><input type="checkbox" checked={chat} onChange={(event) => { touch("chat"); setChat(event.target.checked); }} />Chat: agents, chats, and reports</label>
      <label className="ai-check"><input type="checkbox" checked={embeddings} onChange={(event) => { touch("embeddings"); setEmbeddings(event.target.checked); }} />Embeddings: knowledge bases</label>
      <p className="file-dialog-hint">{capabilitiesHint(chat, embeddings)}</p>
      {chat && <>
        <label htmlFor={ids.model}>Default chat model</label>
        <input id={ids.model} value={defaultModel} maxLength={AGENT_BOUNDS.model} autoComplete="off" spellCheck={false} placeholder={`${DEFAULT_MODEL} (default)`} onChange={(event) => setDefaultModel(event.target.value.replace(/\s+/g, ""))} />
        <span className="ai-label" id={ids.param}>Output-token parameter</span>
        <Select<"max_completion_tokens" | "max_tokens"> labelledBy={ids.param} label="Output-token parameter" value={tokenParam} onChange={(value) => { touch("tokenParam"); setTokenParam(value); }} options={[{ value: "max_completion_tokens", label: "max_completion_tokens", description: "OpenAI" }, { value: "max_tokens", label: "max_tokens", description: "Most compatible servers, Anthropic" }]} />
        <label htmlFor={ids.context}>Context window (tokens)</label>
        <input id={ids.context} type="number" min={1024} max={10_000_000} value={contextTokens} onChange={(event) => { touch("contextTokens"); setContextTokens(Math.min(10_000_000, Math.max(1024, Math.floor(Number(event.target.value) || 1024)))); }} />
        <label className="ai-check"><input type="checkbox" checked={streamUsage} onChange={(event) => setStreamUsage(event.target.checked)} />The server reports token usage while streaming (off: tokens are estimated)</label>
      </>}
      <details className="ai-advanced" open={reasoningEffort !== "omit" || (kindChoice !== "openai" && !detected) || (embeddings && effectiveKind !== "voyage" && dimensionsParam !== "dimensions") || undefined}>
        <summary>Advanced</summary>
        {chat && <>
          <span className="ai-label" id={ids.effort}>Reasoning effort</span>
          <Select<ReasoningEffort> labelledBy={ids.effort} label="Reasoning effort" value={reasoningEffort} onChange={setReasoningEffort} options={REASONING_EFFORT_OPTIONS} />
          <p className="file-dialog-hint">Sent as reasoning_effort with every request to this provider. Some newer OpenAI models refuse tools at their default reasoning in Chat Completions; none fixes that (Test tool calling sets it when it finds this). Nook does not use OpenAI's Responses API yet.</p>
        </>}
        {detected ? <p className="file-dialog-hint">{FLAVOR_LABELS[detected]}: known by its address.</p> : <>
          <span className="ai-label" id={ids.endpointKind}>Provider kind</span>
          <Select<EndpointKind> labelledBy={ids.endpointKind} label="Provider kind" value={kindChoice} onChange={changeKind} options={ENDPOINT_KIND_OPTIONS} />
          <p className="file-dialog-hint">{ENDPOINT_KIND_HINT}</p>
        </>}
        {embeddings && (effectiveKind === "voyage" ? <p className="file-dialog-hint">Embedding size field: output_dimension (Voyage AI's).</p> : <>
          <span className="ai-label" id={ids.sizeParam}>Embedding size field</span>
          <Select<SizeParam> labelledBy={ids.sizeParam} label="Embedding size field" value={dimensionsParam} onChange={setDimensionsParam} options={SIZE_PARAM_OPTIONS} />
          <p className="file-dialog-hint">{SIZE_PARAM_HINT}</p>
        </>)}
      </details>
      {chat && <ProviderVisionFields providerId={provider?.id ?? null} defaultModel={defaultModel.trim() || DEFAULT_MODEL} draft={vision} onChange={setVision} disabled={busy} />}
      {embeddings && <>
        <label htmlFor={ids.embeddingModel}>Embedding model</label>
        <input id={ids.embeddingModel} value={embeddingModel} maxLength={AGENT_BOUNDS.model} autoComplete="off" spellCheck={false} placeholder={`${effectiveKind === "voyage" ? "voyage-3.5" : "text-embedding-3-small"} (default)`} onChange={(event) => setEmbeddingModel(event.target.value.replace(/\s+/g, ""))} />
        <label htmlFor={ids.embeddingDims}>Embedding size (dimensions)</label>
        <input id={ids.embeddingDims} type="number" inputMode="numeric" min={64} max={3072} value={embeddingDims} placeholder="512 (default)" onChange={(event) => setEmbeddingDims(event.target.value)} />
        <p className="file-dialog-hint">New knowledge bases on this provider start with this model and size; their owners may choose others. {effectiveKind === "voyage" ? "Voyage AI takes 256, 512, 1,024, or 2,048." : "Models that take no size (not text-embedding-3) answer in their own."}</p>
        <ProviderKnowledgeFields providerId={provider?.id ?? null} draft={knowledge} onChange={setKnowledge} disabled={busy} />
      </>}
      </>}
      <FormError message={error} />
      <footer className="file-dialog-actions">
        <button type="button" className="secondary-button" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="submit" className="primary-button" disabled={busy}>{busy ? "Saving…" : provider ? "Save" : "Add provider"}</button>
      </footer>
    </form>
  </ModalDialog>;
}

/** D685: the kinds an endpoint can be told to be in Advanced when its host does not say (a proxy). */
export type EndpointKind = "openai" | CompatFlavor;
type SizeParam = NonNullable<ProviderCompat["dimensionsParam"]>;
type ProviderCompatPatch = NonNullable<ProviderInput["compat"]>;
export const ENDPOINT_KIND_OPTIONS: Array<{ value: EndpointKind; label: string; description: string }> = [
  { value: "openai", label: "OpenAI-compatible", description: "OpenAI, Z.ai, vLLM, LiteLLM, Ollama" },
  { value: "anthropic", label: "Anthropic", description: "Sends anthropic-version and x-api-key" },
  { value: "voyage", label: "Voyage AI", description: "Embeddings only, sized by output_dimension" }
];
export const ENDPOINT_KIND_HINT = "For a proxy in front of Anthropic or Voyage AI. Nook knows api.anthropic.com and api.voyageai.com by their address.";
export const SIZE_PARAM_OPTIONS: Array<{ value: SizeParam; label: string; description: string }> = [
  { value: "dimensions", label: "dimensions", description: "OpenAI (text-embedding-3 models)" },
  { value: "output_dimension", label: "output_dimension", description: "Voyage AI's name (its sized models)" }
];
export const SIZE_PARAM_HINT = "The embeddings request's size field. output_dimension also leaves out encoding_format and sends input_type, as Voyage AI expects.";

/**
 * D685: the compat fields the form's kind and size-field choices save. An address that names its kind
 * (`detected`) saves no flavor; otherwise the choice does (null for OpenAI-compatible). A Voyage AI
 * kind is always sized by `output_dimension`; another kind sends the form's field when it embeds. A
 * provider that was Voyage AI and no longer is drops Voyage's four sizes.
 */
export function endpointKindCompat(input: { detected: ProviderFlavor | null; choice: EndpointKind; dimensionsParam: SizeParam; embeddings: boolean; before: ProviderFlavor | null }): Pick<ProviderCompatPatch, "flavor" | "dimensionsParam" | "embeddingSizes"> {
  const kind = input.detected ?? (input.choice === "openai" ? null : input.choice);
  return {
    ...(input.detected ? {} : { flavor: input.choice === "openai" ? null : input.choice }),
    ...(kind === "voyage" ? { dimensionsParam: "output_dimension" as const } : input.embeddings ? { dimensionsParam: input.dimensionsParam } : {}),
    ...(input.before === "voyage" && kind !== "voyage" ? { embeddingSizes: null } : {})
  };
}

/** One probed choice as words: works, not supported (and why), or inconclusive (the flag is unchanged). */
export function probeText(result: ToolCallingProbe["required"]): string {
  const why = result.error ? ` (${result.error})` : "";
  return result.outcome === "supported" ? "works" : result.outcome === "unsupported" ? `not supported${why}` : `inconclusive${why}`;
}

/** The reasoning effort choices of the provider form (2026-10-14): omit sends nothing. */
export const REASONING_EFFORT_OPTIONS: Array<{ value: ReasoningEffort; label: string; description?: string }> = REASONING_EFFORTS.map((value) => ({
  value, label: value === "omit" ? "Don't send" : value, ...(value === "omit" ? { description: "The model's default" } : value === "none" ? { description: "For models that refuse tools while reasoning" } : {})
}));

/** D544: whether a provider is the model built into Nook. */
export const isLocal = (provider: Pick<ProviderSummary, "baseUrl">) => providerFlavor(provider.baseUrl) === "local";

/** What the Add provider dialog says about the local model (D544, D546; D686: the model this server runs, LOCAL_EMBEDDINGS_VARIANT). */
export function localProviderText(local: Pick<LocalEmbeddingStatus, "model" | "dims" | "bytes" | "languages" | "memoryGb"> | null): string {
  const model = local ?? { model: LOCAL_MODEL.id, dims: LOCAL_MODEL.dims, bytes: LOCAL_MODEL_BYTES, languages: LOCAL_MODEL.languages, memoryGb: LOCAL_MODEL.memoryGb };
  return `Runs ${model.model} (${model.dims} dimensions, about ${Math.round(model.bytes / 1_000_000)} MB, ${model.languages}) inside Nook: knowledge bases only, no API key, and nothing leaves the server. It uses one CPU core, one passage at a time (about 1 to 2 seconds each; searches go first), and about ${model.memoryGb} GB of memory while in use; it costs no tokens.`;
}
/** The default model's line (multilingual-e5-small). */
export const LOCAL_PROVIDER_TEXT = localProviderText(null);

/** The Kind choice's line for the local model: why it cannot be added, when it cannot. */
export function localOptionText(local: LocalEmbeddingStatus | null): string {
  if (!local) return "Built into Nook";
  if (!local.allowed) return "Turned off on this server (LOCAL_EMBEDDINGS=off)";
  if (local.added) return "Already added";
  return local.available ? "Built into Nook: knowledge bases only, nothing leaves the server" : "Its model files are not in place on this server (see below)";
}

/** A code value that may wrap after `_`, `-`, `.`, or `/` rather than in the middle of a word (1280 px cards). */
export function breakable(text: string) {
  return text.split(/(?<=[_\-./])/).flatMap((part, index) => index === 0 ? [part] : [<wbr key={index} />, part]);
}

/** D539: what kind of endpoint a provider is, for its card. */
export const endpointLabel = (provider: Pick<ProviderSummary, "baseUrl" | "compat">) => {
  const flavor = providerFlavor(provider.baseUrl, provider.compat);
  return flavor ? FLAVOR_LABELS[flavor] : "OpenAI-compatible";
};

/** D541/D542: what a provider can do, for its card ("Embeddings: none" for Anthropic). */
export function capabilitiesSummary(compat: Pick<ProviderCompat, "chat" | "embeddings">): string {
  const chats = providerChats(compat);
  const embeds = providerEmbeds(compat);
  return chats && embeds ? "Chat and embeddings" : chats ? "Chat · Embeddings: none" : embeds ? "Embeddings only · Chat: none" : "None";
}

/** The dialog's line under the two capability boxes (D541, D542). */
export function capabilitiesHint(chat: boolean, embeddings: boolean): string {
  if (chat && embeddings) return "Offered for chats, agents, and reports, and for knowledge bases.";
  if (chat) return "Never offered for knowledge bases (Anthropic has no embeddings API). Add Local embeddings (built into Nook), OpenAI, or Voyage AI for meaning-based knowledge search.";
  if (embeddings) return "Only for knowledge bases: never a chat or report model, and never the default.";
  return "Choose at least one.";
}

/** What a new provider's address says about it (D539, D542). */
export const FLAVOR_HINTS: Record<ProviderFlavor, string> = {
  anthropic: "Anthropic (OpenAI-compatible endpoint): Nook sends anthropic-version and x-api-key with every request, asks for tools with auto (its current models refuse forced tool choice), and does not use it for embeddings.",
  voyage: "Voyage AI: embeddings only, sized with output_dimension (256, 512, 1,024, or 2,048). Use it for knowledge bases beside a chat provider.",
  local: "Local embeddings run inside Nook: choose Local embeddings as the kind instead of typing an address."
};

/** One Test result as words (D542: an embeddings-only provider is asked for one embedding instead of a completion). */
export function testText(result: ProviderTest): string {
  const models = result.models.skipped ? "Models: not listed by this provider." : result.models.ok ? `Models: ${result.models.count} in ${result.models.latencyMs} ms.` : `Models: ${result.models.error ?? "failed"}.`;
  if (result.embeddings) return `${models} ${result.embeddings.ok ? `Embeddings: ok (${result.embeddings.model}, ${result.embeddings.dims?.toLocaleString("en-US") ?? "?"} dimensions) in ${result.embeddings.latencyMs} ms.` : `Embeddings: ${result.embeddings.error ?? "failed"}.`}`;
  return `${models} ${result.completion.ok ? `Completion: ok (${result.completion.model}) in ${result.completion.latencyMs} ms.` : `Completion: ${result.completion.error ?? "failed"}.`}`;
}

/**
 * "Test tool calling" as words (D540). A forced choice the model refuses is the finding, not a failure:
 * "Forced tool choice: not supported, so Nook uses auto (fine)", and the third probe says whether
 * tools work with auto.
 */
export function probeSummary(probe: ToolCallingProbe): string {
  const saved = probe.inconclusive ? "Inconclusive results leave the saved setting as it was." : "Saved to the provider.";
  const reasoning = probe.reasoning ? ` ${probe.reasoning.note}` : "";
  const forcedRefused = probe.required.forcedRefused || probe.named.forcedRefused;
  if (probe.toolCalling === "auto") {
    const forced = forcedRefused ? "Forced tool choice: not supported, so Nook uses auto (fine)." : `Forced tool choice: required ${probeText(probe.required)}; a named tool ${probeText(probe.named)}. Nook uses auto (fine).`;
    return `Tool calling works (auto) with ${probe.model}. ${forced} ${saved}${reasoning}`;
  }
  if (probe.toolCalling === "none") return `Tool calling does not work with ${probe.model}: it answered without calling the tool, also with auto${probe.auto?.error ? ` (${probe.auto.error})` : ""}. Agents and reports need a model that calls tools. ${saved}${reasoning}`;
  if (probe.toolCalling === "inconclusive" && probe.auto) return `Tool calling (${probe.model}): could not tell; required ${probeText(probe.required)}; a named tool ${probeText(probe.named)}; auto ${probeText(probe.auto)}. ${saved}${reasoning}`;
  return `Tool calling (${probe.model}): required ${probeText(probe.required)}; a named tool ${probeText(probe.named)}. ${probe.inconclusive ? "Inconclusive results leave the saved setting as it was; " : "Saved to the provider; "}Nook ${probe.compat.namedToolChoice ? "names the tool it needs" : probe.compat.requiredToolChoice ? "sends required with only that tool" : "asks with auto and only that tool"}.${reasoning}`;
}

/** A provider's tool-choice flags (wave 46's compat, set by "Test tool calling", wave 48b). */
export function toolChoiceSummary(compat: { requiredToolChoice?: boolean; namedToolChoice?: boolean }): string {
  if (compat.namedToolChoice === false && compat.requiredToolChoice === false) return "auto only";
  if (compat.namedToolChoice === false) return "required (no named tool)";
  if (compat.requiredToolChoice === false) return "named tool (no required)";
  return "required and named";
}
