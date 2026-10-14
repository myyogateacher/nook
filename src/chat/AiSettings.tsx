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
import { AGENT_BOUNDS, AGENT_ROLE_OPTIONS, DEFAULT_BASE_URL, DEFAULT_MODEL, REASONING_EFFORTS, type AgentRole, type ReasoningEffort, type AgentSettings, type ProviderSummary } from "../../shared/agents";
import { agentsStatus, createProvider, deleteProvider, listProviders, messageOf, probeProviderTools, readSettings, testProvider, updateProvider, writeSettings, errorCode, type AgentsStatus, type ProviderTest } from "./chatApi";
import type { ToolCallingProbe } from "../../shared/reportsModel";
import { ToolServersSection } from "./ToolServers";
import { policyDraft, policyFromDraft, policySummary, ProviderKnowledgeFields } from "./ProviderKnowledgePolicy";
import { ProviderVisionFields, visionDraft, visionFromDraft, visionSummary } from "./ProviderVisionPolicy";
import { HUB_TITLE_ID } from "../settings/hubModel";
import "./chat.css";
import { notify } from "../ui/notify";
import { FormError } from "../ui/FormError";

/**
 * Settings → AI (admins; agent chat plan §4.1, §13.4): providers (name, base URL, a write-only API
 * key shown as a hint, default model, compatibility) with Test, and the chat policy (who creates,
 * who chats, daily token budgets). Without AGENT_SECRETS_KEY the page explains what to set and
 * everything else is disabled.
 */

export const SECRET_HONESTY = "Encrypted at rest; anyone with the server and its key can read these secrets.";
const ROLE_LABELS: Record<AgentRole, string> = { admin: "Admins", member: "Members", viewer: "Viewers" };

/**
 * Tabs (each its own URL): Model providers, Tool servers, Chat policy. `tabs` are the ones the
 * role sees (hubModel's aiTabsFor) and `tab` the one on screen; `onSelectTab` navigates.
 */
export function AiSettings({ flash, tabs, tab, onSelectTab }: { flash: (message: string) => void; tabs: readonly AiTab[]; tab: AiTab; onSelectTab: (tab: AiTab) => void }) {
  const [status, setStatus] = useState<AgentsStatus | null>(null);
  const [serverCount, setServerCount] = useState<number | null>(null);
  const [providers, setProviders] = useState<ProviderSummary[] | null>(null);
  const [settings, setSettings] = useState<(AgentSettings & { revision: number }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<ProviderSummary | "new" | null>(null);
  const [tests, setTests] = useState<Record<string, ProviderTest | "running">>({});
  const [probes, setProbes] = useState<Record<string, ToolCallingProbe | "running">>({});
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
        return <li key={provider.id} className="security-card ai-provider">
          <div className="ai-provider-head">
            <div><span className="ai-provider-name"><strong>{provider.name}</strong>{provider.isDefault && <span className="ai-badge">Default</span>}</span><small>{provider.baseUrl}</small></div>
            <div className="ai-provider-actions">
              <button type="button" className="secondary-button" onClick={() => { void test(provider); }} disabled={result === "running"}>{result === "running" ? "Testing…" : "Test"}</button>
              <button type="button" className="secondary-button" onClick={() => { void probeTools(provider); }} disabled={probe === "running"}>{probe === "running" ? "Testing tools…" : "Test tool calling"}</button>
              <button type="button" className="secondary-button" onClick={() => setEditing(provider)}>Edit</button>
              {!provider.isDefault && <button type="button" className="secondary-button" onClick={() => { void makeDefault(provider); }}>Make default</button>}
              <button type="button" className="secondary-button" onClick={() => { void remove(provider); }}>Remove</button>
            </div>
          </div>
          <dl className="ai-provider-facts">
            <div><dt>API key</dt><dd>{provider.hasSecret ? <code>{provider.hint ?? "Saved"}</code> : <span className="chat-muted">none</span>}</dd></div>
            <div><dt>Default model</dt><dd><code>{provider.defaultModel}</code></dd></div>
            <div><dt>Token parameter</dt><dd><code>{provider.compat.tokenParam}</code></dd></div>
            <div><dt>Context</dt><dd>{provider.compat.contextTokens.toLocaleString()} tokens{provider.compat.streamUsage ? "" : " · usage estimated"}</dd></div>
            <div><dt>Knowledge bases</dt><dd>{policySummary(provider.knowledge)}</dd></div>
            <div><dt>Images</dt><dd>{visionSummary(provider.vision)}</dd></div>
            <div><dt>Tool choice</dt><dd>{toolChoiceSummary(provider.compat)}</dd></div>
            {provider.compat.reasoningEffort && <div><dt>Reasoning effort</dt><dd><code>{provider.compat.reasoningEffort}</code></dd></div>}
          </dl>
          {result && result !== "running" && <p className={`ai-test ${result.ok ? "ok" : "failed"}`} role="status">
            {result.models.ok ? `Models: ${result.models.count} in ${result.models.latencyMs} ms.` : `Models: ${result.models.error ?? "failed"}.`} {result.completion.ok ? `Completion: ok (${result.completion.model}) in ${result.completion.latencyMs} ms.` : `Completion: ${result.completion.error ?? "failed"}.`}
          </p>}
          {probe && probe !== "running" && <p className={`ai-test ${probe.compat.requiredToolChoice && probe.compat.namedToolChoice ? "ok" : "failed"}`} role="status">
            Tool calling ({probe.model}): required {probeText(probe.required)}; a named tool {probeText(probe.named)}. {probe.inconclusive ? "Inconclusive results leave the saved setting as it was; " : "Saved to the provider; "}Nook {probe.compat.namedToolChoice ? "names the tool it needs" : probe.compat.requiredToolChoice ? "sends required with only that tool" : "asks with auto and only that tool"}.{probe.reasoning ? ` ${probe.reasoning.note}` : ""}
          </p>}
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
    {editing && <ProviderDialog provider={editing === "new" ? null : editing} onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />}
    {confirm.confirmElement}
  </section>;
}

function PolicyForm({ settings, providers, flash, onSaved }: { settings: AgentSettings & { revision: number }; providers: ProviderSummary[]; flash: (message: string) => void; onSaved: (settings: AgentSettings & { revision: number }) => void }) {
  const [draft, setDraft] = useState(settings);
  const [busy, setBusy] = useState(false);
  useEffect(() => setDraft(settings), [settings]);
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
      <div><span className="ai-label" id="ai-default-provider">Default provider</span><Select<string> labelledBy="ai-default-provider" label="Default provider" value={draft.defaultProviderId ?? providers.find((provider) => provider.isDefault)?.id ?? null} onChange={(value) => setDraft({ ...draft, defaultProviderId: value })} options={providers.map((provider) => ({ value: provider.id, label: provider.name, description: provider.defaultModel }))} placeholder="The provider marked default" disabled={providers.length === 0} /></div>
    </div>
    <fieldset className="ai-report-model">
      <legend className="ai-label">Report generation model</legend>
      <p className="chat-muted">The provider and model that write analytics reports. Chat keeps its default; a report's owner may choose another for one report.</p>
      <div className="ai-policy-grid">
        <div><span className="ai-label" id="ai-report-provider">Provider</span><Select<string> labelledBy="ai-report-provider" label="Report generation provider" value={draft.reportProviderId ?? ""} onChange={(value) => setDraft({ ...draft, reportProviderId: value || null })} options={[{ value: "", label: "Chat's default provider" }, ...providers.map((provider) => ({ value: provider.id, label: provider.name, description: provider.defaultModel }))]} disabled={providers.length === 0} /></div>
        <label>Model<input value={draft.reportModel ?? ""} maxLength={AGENT_BOUNDS.model} placeholder="The provider's default model" autoComplete="off" onChange={(event) => setDraft({ ...draft, reportModel: event.target.value || null })} /><small>For example glm-5.3; empty uses the provider's default</small></label>
      </div>
      <label className="ai-check"><input type="checkbox" checked={draft.reportModelFreeText} onChange={(event) => setDraft({ ...draft, reportModelFreeText: event.target.checked })} />Report owners may type any model name</label>
      <p className="chat-muted">Off: an owner picks from the provider's listed models (seen by Test or the model list), its default, or the report model above.</p>
    </fieldset>
    <fieldset className="ai-report-model">
      <legend className="ai-label">Fallback model for reports</legend>
      <p className="chat-muted">When a report's model uses up its tries or nudges without saving a report, the generation is retried once on this model. Each block records the model that wrote it.</p>
      <div className="ai-policy-grid">
        <div><span className="ai-label" id="ai-report-fallback-provider">Provider</span><Select<string> labelledBy="ai-report-fallback-provider" label="Fallback provider for reports" value={draft.reportFallbackProviderId ?? ""} onChange={(value) => setDraft({ ...draft, reportFallbackProviderId: value || null })} options={[{ value: "", label: "Off (no fallback)" }, ...providers.map((provider) => ({ value: provider.id, label: provider.name, description: provider.defaultModel }))]} disabled={providers.length === 0} /></div>
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

function ProviderDialog({ provider, onCancel, onSaved }: { provider: ProviderSummary | null; onCancel: () => void; onSaved: () => void }) {
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
  const [knowledge, setKnowledge] = useState(() => policyDraft(provider?.knowledge));
  const [vision, setVision] = useState(() => visionDraft(provider?.vision));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ids = { name: useId(), url: useId(), key: useId(), model: useId(), context: useId(), param: useId(), effort: useId() };
  useHistoryDialogGuard(true, onCancel, { blocked: busy });

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return setError("Enter a name.");
    const policy = policyFromDraft(knowledge);
    if ("error" in policy) return setError(policy.error);
    const images = visionFromDraft(vision);
    if ("error" in images) return setError(images.error);
    setBusy(true);
    setError(null);
    const compat = { tokenParam, streamUsage, contextTokens, reasoningEffort };
    try {
      if (provider) await updateProvider(provider.id, { name: name.trim(), baseUrl: baseUrl.trim(), ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}), removeSecret, defaultModel: defaultModel.trim() || DEFAULT_MODEL, compat, vision: images.policy, knowledge: policy.policy, expectedRevision: provider.revision });
      else await createProvider({ name: name.trim(), baseUrl: baseUrl.trim(), apiKey: apiKey.trim() || null, defaultModel: defaultModel.trim() || DEFAULT_MODEL, compat, vision: images.policy, knowledge: policy.policy });
      setApiKey("");
      onSaved();
    } catch (reason) {
      setError(errorCode(reason) === "REVISION_MISMATCH" ? "This provider changed elsewhere; close and reopen it." : messageOf(reason, "Could not save the provider"));
      setBusy(false);
    }
  }
  return <ModalDialog title={provider ? "Edit provider" : "Add provider"} eyebrow="AI" onClose={onCancel} busy={busy} variant="sheet" className="chat-dialog">
    <form className="file-dialog-form ai-provider-form" onSubmit={submit} noValidate>
      <label htmlFor={ids.name}>Name</label>
      <input id={ids.name} value={name} maxLength={AGENT_BOUNDS.providerName} autoFocus autoComplete="off" placeholder="OpenAI" onChange={(event) => setName(event.target.value)} />
      <label htmlFor={ids.url}>Base URL</label>
      <input id={ids.url} value={baseUrl} maxLength={AGENT_BOUNDS.baseUrl} autoComplete="off" spellCheck={false} placeholder={DEFAULT_BASE_URL} onChange={(event) => setBaseUrl(event.target.value)} />
      <p className="file-dialog-hint">https only. A private host (Ollama, LiteLLM, vLLM on your network) must be listed in AGENT_ALLOWED_PRIVATE_HOSTS on the server.</p>
      <label htmlFor={ids.key}>API key {provider?.hasSecret && !removeSecret ? <small>({provider.hint ? `saved: ${provider.hint}` : "saved"}; leave empty to keep it)</small> : null}</label>
      <input id={ids.key} type="password" value={apiKey} maxLength={1024} autoComplete="off" placeholder={provider?.hasSecret ? "Keep the saved key" : "sk-…"} onChange={(event) => { setApiKey(event.target.value); setRemoveSecret(false); }} />
      {provider?.hasSecret && <label className="ai-check"><input type="checkbox" checked={removeSecret} onChange={(event) => setRemoveSecret(event.target.checked)} />Remove the saved key</label>}
      <p className="file-dialog-hint">{SECRET_HONESTY} The key is sent only to this provider's endpoint and is never shown again.</p>
      <label htmlFor={ids.model}>Default chat model</label>
      <input id={ids.model} value={defaultModel} maxLength={AGENT_BOUNDS.model} autoComplete="off" spellCheck={false} placeholder={`${DEFAULT_MODEL} (default)`} onChange={(event) => setDefaultModel(event.target.value.replace(/\s+/g, ""))} />
      <span className="ai-label" id={ids.param}>Output-token parameter</span>
      <Select<"max_completion_tokens" | "max_tokens"> labelledBy={ids.param} label="Output-token parameter" value={tokenParam} onChange={setTokenParam} options={[{ value: "max_completion_tokens", label: "max_completion_tokens", description: "OpenAI" }, { value: "max_tokens", label: "max_tokens", description: "Most compatible servers" }]} />
      <label htmlFor={ids.context}>Context window (tokens)</label>
      <input id={ids.context} type="number" min={1024} max={10_000_000} value={contextTokens} onChange={(event) => setContextTokens(Math.min(10_000_000, Math.max(1024, Math.floor(Number(event.target.value) || 1024))))} />
      <label className="ai-check"><input type="checkbox" checked={streamUsage} onChange={(event) => setStreamUsage(event.target.checked)} />The server reports token usage while streaming (off: tokens are estimated)</label>
      <details className="ai-advanced" open={reasoningEffort !== "omit" || undefined}>
        <summary>Advanced</summary>
        <span className="ai-label" id={ids.effort}>Reasoning effort</span>
        <Select<ReasoningEffort> labelledBy={ids.effort} label="Reasoning effort" value={reasoningEffort} onChange={setReasoningEffort} options={REASONING_EFFORT_OPTIONS} />
        <p className="file-dialog-hint">Sent as reasoning_effort with every request to this provider. Some newer OpenAI models refuse tools at their default reasoning in Chat Completions; none fixes that (Test tool calling sets it when it finds this). Nook does not use OpenAI's Responses API yet.</p>
      </details>
      <ProviderVisionFields providerId={provider?.id ?? null} defaultModel={defaultModel.trim() || DEFAULT_MODEL} draft={vision} onChange={setVision} disabled={busy} />
      <ProviderKnowledgeFields providerId={provider?.id ?? null} draft={knowledge} onChange={setKnowledge} disabled={busy} />
      <FormError message={error} />
      <footer className="file-dialog-actions">
        <button type="button" className="secondary-button" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="submit" className="primary-button" disabled={busy}>{busy ? "Saving…" : provider ? "Save" : "Add provider"}</button>
      </footer>
    </form>
  </ModalDialog>;
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

/** A provider's tool-choice flags (wave 46's compat, set by "Test tool calling", wave 48b). */
export function toolChoiceSummary(compat: { requiredToolChoice?: boolean; namedToolChoice?: boolean }): string {
  if (compat.namedToolChoice === false && compat.requiredToolChoice === false) return "auto only";
  if (compat.namedToolChoice === false) return "required (no named tool)";
  if (compat.requiredToolChoice === false) return "named tool (no required)";
  return "required and named";
}
