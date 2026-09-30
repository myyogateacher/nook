import { useEffect, useId, useMemo, useState, type FormEvent } from "react";
import { ArrowDown, ArrowUp, Copy, Eye, EyeOff, History, KeyRound, Pencil, Plus, RefreshCw, Trash2, Wand2, X } from "lucide-react";
import { ApiError } from "../api";
import { ModalDialog } from "../files/Dialog";
import { Select } from "../ui/Select";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";
import type { ConfirmRequest } from "../ui/useConfirm";
import { DEFAULT_ENVIRONMENTS, formatLoginValue, isTag, parseLoginValue, SECRET_TYPES, SLUG_PATTERN, utf8Length, VAULT_BOUNDS, type SecretType } from "../../shared/vault";
import { DEFAULT_GENERATOR, generate, GENERATOR_BOUNDS, strengthLabel, type GeneratorKind, type GeneratorOptions } from "./generator";
import { MASK, type Revealed } from "./reveal";
import {
  createEnvironment, createSecret, createVault, deleteEnvironment, deleteVault, getVault, readValue, reorderEnvironments, setValue, setValues, updateEnvironment, updateSecret, updateVault,
  type SecretDetail, type SecretSummary, type VaultEnvironment, type VaultSummary
} from "./vaultApi";

/**
 * The Vault's sheets and dialogs (vault plan §10). Each is one history layer (useHistoryDialogGuard):
 * Back closes it first, at every width (D18). Pickers are the shared Select (D91); confirmations go
 * through useConfirm. Values render as text nodes only, and every value field has autocomplete and
 * spellcheck off (T186, T187).
 */

export const messageOf = (reason: unknown, fallback: string) => reason instanceof Error ? reason.message : fallback;
export const errorCode = (reason: unknown) => reason instanceof ApiError && reason.payload && typeof reason.payload === "object" ? (reason.payload as { code?: string }).code : undefined;
const payloadNumber = (reason: unknown, key: string) => reason instanceof ApiError && reason.payload && typeof reason.payload === "object" ? (reason.payload as Record<string, unknown>)[key] as number | undefined : undefined;

export const TYPE_LABELS: Record<SecretType, string> = { value: "Value", login: "Login", note: "Note" };
const TYPE_OPTIONS = SECRET_TYPES.map((type) => ({ value: type, label: TYPE_LABELS[type], description: type === "value" ? "One string: a token, URL, or key" : type === "login" ? "A username, password, and URL" : "Multi-line text" }));
export const canWriteEnv = (env: Pick<VaultEnvironment, "level">) => env.level === "write" || env.level === "admin";
const valueFieldProps = { autoComplete: "off", autoCorrect: "off", autoCapitalize: "off", spellCheck: false, "data-1p-ignore": true, "data-lpignore": "true" } as const;

function parseTagInput(text: string): { tags: string[]; error: string | null } {
  const tags = [...new Set(text.split(/[\s,]+/).map((tag) => tag.trim()).filter(Boolean))];
  if (tags.length > VAULT_BOUNDS.tags) return { tags, error: `At most ${VAULT_BOUNDS.tags} tags` };
  if (!tags.every(isTag)) return { tags, error: "Tags are 1–32 characters without spaces or commas" };
  return { tags, error: null };
}

// ---------------------------------------------------------------------------------------------
// New vault

type EnvDraft = { key: string; slug: string; name: string; protected: boolean };

export function NewVaultDialog({ onCancel, onCreated }: { onCancel: () => void; onCreated: (vault: VaultSummary) => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [envs, setEnvs] = useState<EnvDraft[]>(() => DEFAULT_ENVIRONMENTS.map((env) => ({ key: crypto.randomUUID(), ...env })));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameId = useId();
  const descriptionId = useId();
  useHistoryDialogGuard(true, onCancel, { blocked: busy });

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return setError("Enter a name.");
    if (envs.length === 0) return setError("Add at least one environment.");
    const bad = envs.find((env) => !SLUG_PATTERN.test(env.slug) || !env.name.trim());
    if (bad) return setError("Each environment needs a name and a short name of lowercase letters, digits, and hyphens.");
    setBusy(true);
    setError(null);
    try {
      const { vault } = await createVault({ name: name.trim(), description: description.trim(), environments: envs.map((env) => ({ slug: env.slug, name: env.name.trim(), protected: env.protected })) });
      onCreated(vault);
    } catch (reason) {
      setError(messageOf(reason, "Could not create the vault"));
      setBusy(false);
    }
  }

  const patch = (key: string, change: Partial<EnvDraft>) => setEnvs((current) => current.map((env) => env.key === key ? { ...env, ...change } : env));
  return <ModalDialog title="New vault" eyebrow="Vault" onClose={onCancel} busy={busy} variant="sheet" className="vault-dialog">
    <form className="file-dialog-form vault-form" onSubmit={submit}>
      <label htmlFor={nameId}>Name</label>
      <input id={nameId} value={name} maxLength={VAULT_BOUNDS.vaultName} autoFocus autoComplete="off" placeholder="Payments" onChange={(event) => { setName(event.target.value); setError(null); }} />
      <label htmlFor={descriptionId}>Description</label>
      <input id={descriptionId} value={description} maxLength={VAULT_BOUNDS.description} autoComplete="off" placeholder="Optional" onChange={(event) => setDescription(event.target.value)} />
      <span className="vault-field-label">Environments</span>
      <ul className="vault-env-drafts">
        {envs.map((env) => <li key={env.key}>
          <input aria-label="Environment name" value={env.name} maxLength={VAULT_BOUNDS.envName} autoComplete="off" onChange={(event) => patch(env.key, { name: event.target.value })} />
          <input aria-label="Short name" className="vault-slug-input" value={env.slug} maxLength={VAULT_BOUNDS.slug} autoComplete="off" spellCheck={false} onChange={(event) => patch(env.key, { slug: event.target.value.toLowerCase() })} />
          <button type="button" className="icon-button" aria-label={`Remove ${env.name || "environment"}`} onClick={() => setEnvs((current) => current.filter((item) => item.key !== env.key))}><X /></button>
        </li>)}
      </ul>
      {envs.length < VAULT_BOUNDS.environments && <button type="button" className="secondary-button vault-inline-button" onClick={() => setEnvs((current) => [...current, { key: crypto.randomUUID(), slug: "", name: "", protected: false }])}><Plus />Add environment</button>}
      <p className="file-dialog-hint">Names and tags are not encrypted. Put anything sensitive in a value or a comment.</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      <footer className="file-dialog-actions">
        <button type="button" className="secondary-button" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="submit" className="primary-button" disabled={busy}>{busy ? "Creating…" : "Create vault"}</button>
      </footer>
    </form>
  </ModalDialog>;
}

// ---------------------------------------------------------------------------------------------
// New secret

export function NewSecretDialog({ vault, initialEnvId, onCancel, onCreated }: { vault: VaultSummary; initialEnvId: string | null; onCancel: () => void; onCreated: (secret: SecretDetail) => void }) {
  const writable = vault.environments.filter(canWriteEnv);
  const [name, setName] = useState("");
  const [type, setType] = useState<SecretType>("value");
  const [envId, setEnvId] = useState<string | null>(writable.find((env) => env.id === initialEnvId)?.id ?? writable[0]?.id ?? null);
  const [value, setValueText] = useState("");
  const [login, setLogin] = useState({ username: "", password: "", url: "" });
  const [comment, setComment] = useState("");
  const [tagText, setTagText] = useState("");
  const [generating, setGenerating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ids = { name: useId(), value: useId(), comment: useId(), tags: useId(), type: useId(), env: useId() };
  useHistoryDialogGuard(true, onCancel, { blocked: busy });

  const payload = type === "login" ? (login.username || login.password || login.url ? formatLoginValue(login) : "") : value;
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return setError("Enter a name.");
    const tags = parseTagInput(tagText);
    if (tags.error) return setError(tags.error);
    if (utf8Length(payload) > VAULT_BOUNDS.valueBytes) return setError("The value is larger than 64 KiB.");
    setBusy(true);
    setError(null);
    try {
      const { secret } = await createSecret(vault.id, {
        name: name.trim(), type, comment: comment.trim() || null, tags: tags.tags,
        ...(payload && envId ? { values: { [envId]: { value: payload } } } : {})
      });
      onCreated(secret);
    } catch (reason) {
      setError(messageOf(reason, "Could not create the secret"));
      setBusy(false);
    }
  }

  return <><ModalDialog title="New secret" eyebrow={vault.name} onClose={onCancel} busy={busy || generating} variant="sheet" className="vault-dialog">
    <form className="file-dialog-form vault-form" onSubmit={submit}>
      <label htmlFor={ids.name}>Name</label>
      <input id={ids.name} value={name} maxLength={VAULT_BOUNDS.secretName} autoFocus autoComplete="off" spellCheck={false} placeholder="DATABASE_URL" onChange={(event) => { setName(event.target.value); setError(null); }} />
      <span id={ids.type} className="vault-field-label">Type</span>
      <Select labelledBy={ids.type} value={type} onChange={setType} options={TYPE_OPTIONS} disabled={busy} />
      {writable.length > 0 && <>
        <span id={ids.env} className="vault-field-label">First value in</span>
        <Select labelledBy={ids.env} value={envId} onChange={setEnvId} options={writable.map((env) => ({ value: env.id, label: env.name, description: env.slug }))} disabled={busy} />
        <ValueFields type={type} value={value} login={login} onValue={setValueText} onLogin={setLogin} valueId={ids.value} onGenerate={() => setGenerating(true)} disabled={busy} optional />
      </>}
      <label htmlFor={ids.comment}>Comment (encrypted)</label>
      <input id={ids.comment} value={comment} maxLength={VAULT_BOUNDS.commentBytes} autoComplete="off" onChange={(event) => setComment(event.target.value)} placeholder="Where it is used, who rotates it" />
      <label htmlFor={ids.tags}>Tags (not encrypted)</label>
      <input id={ids.tags} value={tagText} autoComplete="off" spellCheck={false} placeholder="db, payments" onChange={(event) => setTagText(event.target.value)} />
      {error && <p className="form-error" role="alert">{error}</p>}
      <footer className="file-dialog-actions">
        <button type="button" className="secondary-button" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="submit" className="primary-button" disabled={busy}>{busy ? "Creating…" : "Create secret"}</button>
      </footer>
    </form>
  </ModalDialog>
  {generating && <GeneratorDialog onCancel={() => setGenerating(false)} onUse={(generated) => {
    setGenerating(false);
    if (type === "login") setLogin((current) => ({ ...current, password: generated }));
    else setValueText(generated);
  }} />}</>;
}

/** The value inputs: one text area, or a login's three fields; Generate fills the value or the password. */
function ValueFields({ type, value, login, onValue, onLogin, valueId, onGenerate, disabled, optional = false }: {
  type: SecretType; value: string; login: { username: string; password: string; url: string };
  onValue: (value: string) => void; onLogin: (login: { username: string; password: string; url: string }) => void;
  valueId: string; onGenerate: () => void; disabled: boolean; optional?: boolean;
}) {
  const userId = useId();
  const urlId = useId();
  const generate = <button type="button" className="secondary-button vault-inline-button" onClick={onGenerate} disabled={disabled}><Wand2 />Generate</button>;
  if (type === "login") {
    return <div className="vault-login-fields">
      <label htmlFor={userId}>Username</label>
      <input id={userId} value={login.username} disabled={disabled} {...valueFieldProps} onChange={(event) => onLogin({ ...login, username: event.target.value })} />
      <label htmlFor={valueId}>Password{optional ? " (optional)" : ""}</label>
      <div className="vault-value-row">
        <input id={valueId} className="vault-secret-input" type="text" value={login.password} disabled={disabled} {...valueFieldProps} onChange={(event) => onLogin({ ...login, password: event.target.value })} />
        {generate}
      </div>
      <label htmlFor={urlId}>URL</label>
      <input id={urlId} value={login.url} disabled={disabled} {...valueFieldProps} inputMode="url" onChange={(event) => onLogin({ ...login, url: event.target.value })} />
    </div>;
  }
  return <>
    <div className="vault-value-label"><label htmlFor={valueId}>Value{optional ? " (optional)" : ""}</label>{generate}</div>
    <textarea id={valueId} className="vault-secret-input" rows={type === "note" ? 6 : 3} value={value} disabled={disabled} {...valueFieldProps} onChange={(event) => onValue(event.target.value)} />
  </>;
}

// ---------------------------------------------------------------------------------------------
// Generator (§6.7)

const KIND_OPTIONS: Array<{ value: GeneratorKind; label: string; description: string }> = [
  { value: "characters", label: "Characters", description: "Letters, digits, and symbols" },
  { value: "hex", label: "Hex token", description: "Random bytes as hex" },
  { value: "base64url", label: "Base64url token", description: "Random bytes, URL-safe" },
  { value: "passphrase", label: "Passphrase", description: "Random words" }
];
const SEPARATOR_OPTIONS: Array<{ value: GeneratorOptions["separator"]; label: string }> = [
  { value: "-", label: "Hyphen (-)" }, { value: ".", label: "Dot (.)" }, { value: "_", label: "Underscore (_)" }, { value: " ", label: "Space" }
];

export function GeneratorDialog({ onCancel, onUse }: { onCancel: () => void; onUse: (value: string) => void }) {
  const [options, setOptions] = useState<GeneratorOptions>(DEFAULT_GENERATOR);
  const [round, setRound] = useState(0);
  // `round` is the Again button: a new value with the same options.
  const result = useMemo(() => { void round; return generate(options); }, [options, round]);
  const kindId = useId();
  const sizeId = useId();
  const separatorId = useId();
  useHistoryDialogGuard(true, onCancel);
  const bounds = options.kind === "passphrase" ? GENERATOR_BOUNDS.words : options.kind === "characters" ? GENERATOR_BOUNDS.length : GENERATOR_BOUNDS.bytes;
  const size = options.kind === "passphrase" ? options.words : options.kind === "characters" ? options.length : options.bytes;
  const setSize = (next: number) => setOptions((current) => current.kind === "passphrase" ? { ...current, words: next } : current.kind === "characters" ? { ...current, length: next } : { ...current, bytes: next });
  const sets = options.sets;
  return <ModalDialog title="Generate a value" eyebrow="Vault" onClose={onCancel} className="vault-dialog vault-generator">
    <div className="file-dialog-form vault-form">
      <span id={kindId} className="vault-field-label">Kind</span>
      <Select labelledBy={kindId} value={options.kind} onChange={(kind) => setOptions((current) => ({ ...current, kind }))} options={KIND_OPTIONS} />
      <label htmlFor={sizeId}>{options.kind === "passphrase" ? "Words" : options.kind === "characters" ? "Length" : "Bytes"} ({bounds[0]}–{bounds[1]})</label>
      <div className="vault-range-row">
        <input id={sizeId} type="range" min={bounds[0]} max={bounds[1]} value={size} onChange={(event) => setSize(Number(event.target.value))} />
        <output htmlFor={sizeId}>{size}</output>
      </div>
      {options.kind === "characters" && <fieldset className="vault-sets">
        <legend className="vault-field-label">Characters</legend>
        {(["lower", "upper", "digits", "symbols"] as const).map((key) => <label key={key} className="vault-check">
          <input type="checkbox" checked={sets[key]} onChange={(event) => setOptions((current) => ({ ...current, sets: { ...current.sets, [key]: event.target.checked } }))} />
          {{ lower: "a–z", upper: "A–Z", digits: "0–9", symbols: "Symbols (!#%+-.:=@^_~)" }[key]}
        </label>)}
      </fieldset>}
      {options.kind === "passphrase" && <>
        <span id={separatorId} className="vault-field-label">Separator</span>
        <Select labelledBy={separatorId} value={options.separator} onChange={(separator) => setOptions((current) => ({ ...current, separator }))} options={SEPARATOR_OPTIONS} />
      </>}
      <code className="vault-generated" aria-live="polite">{result.value}</code>
      <p className="file-dialog-hint">{strengthLabel(result.bits)}. Made in this browser; nothing is sent until you save.</p>
      <footer className="file-dialog-actions">
        <button type="button" className="secondary-button" onClick={() => setRound((current) => current + 1)}><RefreshCw />Again</button>
        <button type="button" className="primary-button" onClick={() => onUse(result.value)}>Use this</button>
      </footer>
    </div>
  </ModalDialog>;
}

// ---------------------------------------------------------------------------------------------
// Edit one value, with CAS (VALUE_CHANGED) and "apply to other environments"

export function ValueEditorDialog({ vault, secret, env, onCancel, onSaved }: {
  vault: VaultSummary; secret: SecretSummary; env: VaultEnvironment; onCancel: () => void; onSaved: (message: string) => void;
}) {
  const cell = secret.values[env.id];
  const [loading, setLoading] = useState(cell?.status === "set");
  const [expectedVersion, setExpectedVersion] = useState(cell?.version ?? 0);
  const [value, setValueText] = useState("");
  const [login, setLogin] = useState({ username: "", password: "", url: "" });
  const [comment, setComment] = useState("");
  const [applyTo, setApplyTo] = useState<string[]>([]);
  const [generating, setGenerating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<number | null>(null);
  const valueId = useId();
  const commentId = useId();
  useHistoryDialogGuard(true, onCancel, { blocked: busy });
  const others = vault.environments.filter((item) => item.id !== env.id && canWriteEnv(item));

  async function loadCurrent() {
    setLoading(true);
    setError(null);
    try {
      const { value: current } = await readValue(vault.id, secret.id, env.id);
      if (secret.type === "login") setLogin(parseLoginValue(current.value) ?? { username: "", password: current.value, url: "" });
      else setValueText(current.value);
      setComment(current.comment ?? "");
      setExpectedVersion(current.version);
      setConflict(null);
    } catch (reason) {
      if (errorCode(reason) === "VALUE_NOT_SET") {
        setExpectedVersion(payloadNumber(reason, "currentVersion") ?? expectedVersion);
        setConflict(null);
      } else setError(messageOf(reason, "Could not load the current value"));
    } finally {
      setLoading(false);
    }
  }
  // Editing starts from the current value, which is a read (audited like a reveal).
  useEffect(() => { if (cell?.status === "set") void loadCurrent(); }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const payload = secret.type === "login" ? formatLoginValue(login) : value;
    if (utf8Length(payload) > VAULT_BOUNDS.valueBytes) return setError("The value is larger than 64 KiB.");
    setBusy(true);
    setError(null);
    try {
      if (applyTo.length === 0) {
        await setValue(vault.id, secret.id, env.id, { value: payload, comment: comment.trim() || null, expectedVersion });
      } else {
        await setValues(vault.id, secret.id, [
          { envId: env.id, value: payload, comment: comment.trim() || null, expectedVersion },
          ...applyTo.map((envId) => ({ envId, value: payload, comment: comment.trim() || null, expectedVersion: secret.values[envId]?.version ?? 0 }))
        ]);
      }
      onSaved(applyTo.length ? `Saved in ${applyTo.length + 1} environments` : `Saved in ${env.name}`);
    } catch (reason) {
      setBusy(false);
      if (errorCode(reason) === "VALUE_CHANGED") {
        setConflict(payloadNumber(reason, "currentVersion") ?? null);
        return;
      }
      setError(messageOf(reason, "Could not save the value"));
    }
  }

  return <><ModalDialog title={`${secret.name} · ${env.name}`} eyebrow={cell?.status === "set" ? `Edit value · version ${expectedVersion}` : "Set value"} onClose={onCancel} busy={busy || generating} variant="sheet" className="vault-dialog">
    <form className="file-dialog-form vault-form" onSubmit={submit} aria-busy={loading || undefined}>
      {loading ? <p className="file-dialog-hint" role="status">Loading the current value…</p> : <>
        <ValueFields type={secret.type} value={value} login={login} onValue={setValueText} onLogin={setLogin} valueId={valueId} onGenerate={() => setGenerating(true)} disabled={busy} />
        <label htmlFor={commentId}>Comment for this value (encrypted)</label>
        <input id={commentId} value={comment} maxLength={VAULT_BOUNDS.commentBytes} autoComplete="off" onChange={(event) => setComment(event.target.value)} />
        {others.length > 0 && <fieldset className="vault-sets">
          <legend className="vault-field-label">Also save in</legend>
          {others.map((other) => <label key={other.id} className="vault-check">
            <input type="checkbox" checked={applyTo.includes(other.id)} disabled={busy} onChange={(event) => setApplyTo((current) => event.target.checked ? [...current, other.id] : current.filter((id) => id !== other.id))} />
            {other.name}{secret.values[other.id]?.status === "set" ? " (replaces its value)" : ""}
          </label>)}
        </fieldset>}
      </>}
      {conflict !== null && <div className="vault-conflict" role="alert">
        <p>This value changed since you opened it{conflict ? ` (it is now version ${conflict})` : ""}. Your text is still here and nothing was saved.</p>
        <button type="button" className="secondary-button vault-inline-button" onClick={() => { void loadCurrent(); }}><RefreshCw />Load the latest</button>
      </div>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <footer className="file-dialog-actions">
        <button type="button" className="secondary-button" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="submit" className="primary-button" disabled={busy || loading || conflict !== null}>{busy ? "Saving…" : "Save"}</button>
      </footer>
    </form>
  </ModalDialog>
  {generating && <GeneratorDialog onCancel={() => setGenerating(false)} onUse={(generated) => {
    setGenerating(false);
    if (secret.type === "login") setLogin((current) => ({ ...current, password: generated }));
    else setValueText(generated);
  }} />}</>;
}

// ---------------------------------------------------------------------------------------------
// One cell (desktop grid): reveal, copy, edit, clear

export function RevealedText({ type, revealed }: { type: SecretType; revealed: Revealed }) {
  const login = type === "login" ? parseLoginValue(revealed.value) : null;
  if (login) {
    return <dl className="vault-login-view">
      <dt>Username</dt><dd><code>{login.username}</code></dd>
      <dt>Password</dt><dd><code>{login.password}</code></dd>
      {login.url && <><dt>URL</dt><dd><code>{login.url}</code></dd></>}
    </dl>;
  }
  return <code className="vault-value-text">{revealed.value}</code>;
}

export function Masked() {
  return <span className="vault-masked"><span aria-hidden="true">{MASK}</span><span className="sr-only">hidden value</span></span>;
}

export function CellDialog({ vault, secret, env, revealed, onReveal, onHide, onCopy, onEdit, onClear, onOpenSecret, onClose }: {
  vault: VaultSummary; secret: SecretSummary; env: VaultEnvironment; revealed: Revealed | null;
  onReveal: () => void; onHide: () => void; onCopy: () => void; onEdit: () => void; onClear: () => void; onOpenSecret: () => void; onClose: () => void;
}) {
  useHistoryDialogGuard(true, onClose);
  const cell = secret.values[env.id];
  const set = cell?.status === "set";
  return <ModalDialog title={`${secret.name} · ${env.name}`} eyebrow={vault.name} onClose={onClose} className="vault-dialog vault-cell-dialog">
    <div className="vault-cell-body">
      {set ? (revealed ? <RevealedText type={secret.type} revealed={revealed} /> : <Masked />) : <p className="file-dialog-hint">Not set in {env.name}.</p>}
      {revealed?.comment && <p className="vault-value-comment">{revealed.comment}</p>}
      {set && <p className="file-dialog-hint">Version {cell.version}{cell.updatedBy ? ` · ${cell.updatedBy}` : ""}{revealed ? " · hides again after 30 seconds" : ""}</p>}
    </div>
    <footer className="file-dialog-actions vault-cell-actions">
      {set && (revealed ? <button type="button" className="secondary-button" onClick={onHide}><EyeOff />Hide</button> : <button type="button" className="secondary-button" onClick={onReveal} autoFocus><Eye />Reveal</button>)}
      {set && <button type="button" className="secondary-button" onClick={onCopy}><Copy />Copy</button>}
      {canWriteEnv(env) && <button type="button" className="secondary-button" onClick={onEdit}><Pencil />{set ? "Edit" : "Set value"}</button>}
      {set && canWriteEnv(env) && <button type="button" className="danger-button" onClick={onClear}><Trash2 />Clear</button>}
      <button type="button" className="secondary-button" onClick={onOpenSecret}><History />Details</button>
    </footer>
  </ModalDialog>;
}

// ---------------------------------------------------------------------------------------------
// Secret details: name, type, tags, comment (D216 enforced by the server)

export function SecretMetaDialog({ vault, secret, onCancel, onSaved }: { vault: VaultSummary; secret: SecretDetail; onCancel: () => void; onSaved: (secret: SecretDetail) => void }) {
  const hasValues = Object.values(secret.values).some((cell) => cell.status === "set" || (cell.version ?? 0) > 0);
  const [name, setName] = useState(secret.name);
  const [type, setType] = useState<SecretType>(secret.type);
  const [tagText, setTagText] = useState(secret.tags.join(", "));
  const [comment, setComment] = useState(secret.comment ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ids = { name: useId(), type: useId(), tags: useId(), comment: useId() };
  useHistoryDialogGuard(true, onCancel, { blocked: busy });

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return setError("Enter a name.");
    const tags = parseTagInput(tagText);
    if (tags.error) return setError(tags.error);
    setBusy(true);
    setError(null);
    try {
      const result = await updateSecret(vault.id, secret.id, {
        ...(name.trim() !== secret.name ? { name: name.trim() } : {}), ...(type !== secret.type ? { type } : {}),
        tags: tags.tags, comment: comment.trim() || null, expectedRevision: secret.revision
      });
      onSaved(result.secret);
    } catch (reason) {
      setError(errorCode(reason) === "REVISION_CHANGED" ? "This secret changed since you opened it. Close this, and open it again to see the latest." : messageOf(reason, "Could not save"));
      setBusy(false);
    }
  }

  return <ModalDialog title="Edit secret" eyebrow={vault.name} onClose={onCancel} busy={busy} variant="sheet" className="vault-dialog">
    <form className="file-dialog-form vault-form" onSubmit={submit}>
      <label htmlFor={ids.name}>Name</label>
      <input id={ids.name} value={name} maxLength={VAULT_BOUNDS.secretName} autoFocus autoComplete="off" spellCheck={false} onChange={(event) => setName(event.target.value)} />
      <span id={ids.type} className="vault-field-label">Type</span>
      <Select labelledBy={ids.type} value={type} onChange={setType} options={TYPE_OPTIONS} disabled={busy || hasValues} />
      {hasValues && <p className="file-dialog-hint">The type can change only while the secret has no values or history.</p>}
      <label htmlFor={ids.tags}>Tags (not encrypted)</label>
      <input id={ids.tags} value={tagText} autoComplete="off" spellCheck={false} onChange={(event) => setTagText(event.target.value)} />
      <label htmlFor={ids.comment}>Comment (encrypted)</label>
      <textarea id={ids.comment} rows={3} value={comment} maxLength={VAULT_BOUNDS.commentBytes} onChange={(event) => setComment(event.target.value)} />
      {error && <p className="form-error" role="alert">{error}</p>}
      <footer className="file-dialog-actions">
        <button type="button" className="secondary-button" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="submit" className="primary-button" disabled={busy}>{busy ? "Saving…" : "Save"}</button>
      </footer>
    </form>
  </ModalDialog>;
}

// ---------------------------------------------------------------------------------------------
// Vault settings: name, description, environments (owner), and delete

export function VaultSettingsDialog({ vault, onCancel, onChanged, onDeleted, ask, flash }: {
  vault: VaultSummary; onCancel: () => void; onChanged: (vault: VaultSummary) => void; onDeleted: () => void;
  ask: (request: ConfirmRequest) => Promise<boolean>; flash: (message: string) => void;
}) {
  const owner = vault.role === "owner";
  const [current, setCurrent] = useState(vault);
  const [name, setName] = useState(vault.name);
  const [description, setDescription] = useState(vault.description);
  const [names, setNames] = useState<Record<string, string>>(() => Object.fromEntries(vault.environments.map((env) => [env.id, env.name])));
  const [newEnv, setNewEnv] = useState({ name: "", slug: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ids = { name: useId(), description: useId(), envName: useId(), envSlug: useId() };
  useHistoryDialogGuard(true, onCancel, { blocked: busy });

  async function run(action: () => Promise<VaultSummary | null>, done?: string) {
    setBusy(true);
    setError(null);
    try {
      const next = await action();
      if (next) {
        setCurrent(next);
        setNames(Object.fromEntries(next.environments.map((env) => [env.id, env.name])));
        onChanged(next);
      }
      if (done) flash(done);
    } catch (reason) {
      setError(errorCode(reason) === "REVISION_CHANGED" ? "This vault changed since you opened it. Close this and open it again." : messageOf(reason, "Could not save"));
    } finally {
      setBusy(false);
    }
  }
  const refreshed = async () => (await getVault(vault.id)).vault;

  const move = (index: number, delta: number) => {
    const order = current.environments.map((env) => env.id);
    const [moved] = order.splice(index, 1);
    order.splice(index + delta, 0, moved!);
    void run(async () => (await reorderEnvironments(vault.id, order, current.revision)).vault);
  };

  return <ModalDialog title="Vault settings" eyebrow={current.name} onClose={onCancel} busy={busy} variant="sheet" className="vault-dialog vault-settings">
    <div className="file-dialog-form vault-form">
      <form className="vault-settings-block" onSubmit={(event) => { event.preventDefault(); void run(async () => (await updateVault(vault.id, { name: name.trim(), description: description.trim(), expectedRevision: current.revision })).vault, "Saved"); }}>
        <label htmlFor={ids.name}>Name</label>
        <input id={ids.name} value={name} maxLength={VAULT_BOUNDS.vaultName} disabled={!owner || busy} autoComplete="off" onChange={(event) => setName(event.target.value)} />
        <label htmlFor={ids.description}>Description</label>
        <input id={ids.description} value={description} maxLength={VAULT_BOUNDS.description} disabled={!owner || busy} autoComplete="off" onChange={(event) => setDescription(event.target.value)} />
        {owner && <button type="submit" className="secondary-button vault-inline-button" disabled={busy || !name.trim() || (name.trim() === current.name && description.trim() === current.description)}>Save name and description</button>}
      </form>

      <span className="vault-field-label">Environments</span>
      <ul className="vault-env-settings">
        {current.environments.map((env, index) => <li key={env.id}>
          <input aria-label={`Name of ${env.slug}`} value={names[env.id] ?? env.name} maxLength={VAULT_BOUNDS.envName} disabled={busy || env.level !== "admin"} autoComplete="off" onChange={(event) => setNames((all) => ({ ...all, [env.id]: event.target.value }))} />
          <span className="vault-slug">{env.slug}</span>
          {env.level === "admin" && (names[env.id] ?? env.name).trim() !== env.name && <button type="button" className="secondary-button vault-inline-button" disabled={busy || !(names[env.id] ?? "").trim()} onClick={() => { void run(async () => { await updateEnvironment(vault.id, env.id, { name: (names[env.id] ?? "").trim() }); return refreshed(); }, "Renamed"); }}>Save</button>}
          {owner && <button type="button" className="icon-button" aria-label={`Move ${env.name} up`} disabled={busy || index === 0} onClick={() => move(index, -1)}><ArrowUp /></button>}
          {owner && <button type="button" className="icon-button" aria-label={`Move ${env.name} down`} disabled={busy || index === current.environments.length - 1} onClick={() => move(index, 1)}><ArrowDown /></button>}
          {env.level === "admin" && <button type="button" className="icon-button" aria-label={`Delete ${env.name}`} disabled={busy || current.environments.length <= 1} onClick={() => {
            void ask({ title: `Delete ${env.name}?`, message: `${env.name} and its values move to the Bin for 30 days. Restoring it brings the values back.`, confirmLabel: "Move to Bin", danger: true }).then((confirmed) => {
              if (confirmed) void run(async () => { await deleteEnvironment(vault.id, env.id); return refreshed(); }, `Moved ${env.name} to the Bin`);
            });
          }}><Trash2 /></button>}
        </li>)}
      </ul>
      {owner && current.environments.length < VAULT_BOUNDS.environments && <form className="vault-env-add" onSubmit={(event) => {
        event.preventDefault();
        if (!newEnv.name.trim() || !SLUG_PATTERN.test(newEnv.slug)) return setError("A new environment needs a name and a short name of lowercase letters, digits, and hyphens.");
        void run(async () => { await createEnvironment(vault.id, { name: newEnv.name.trim(), slug: newEnv.slug }); setNewEnv({ name: "", slug: "" }); return refreshed(); }, "Environment added");
      }}>
        <input id={ids.envName} aria-label="New environment name" placeholder="QA" value={newEnv.name} maxLength={VAULT_BOUNDS.envName} autoComplete="off" disabled={busy} onChange={(event) => setNewEnv((draft) => ({ ...draft, name: event.target.value }))} />
        <input id={ids.envSlug} aria-label="New environment short name" className="vault-slug-input" placeholder="qa" value={newEnv.slug} maxLength={VAULT_BOUNDS.slug} autoComplete="off" spellCheck={false} disabled={busy} onChange={(event) => setNewEnv((draft) => ({ ...draft, slug: event.target.value.toLowerCase() }))} />
        <button type="submit" className="secondary-button vault-inline-button" disabled={busy}><Plus />Add</button>
      </form>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <p className="file-dialog-hint"><KeyRound className="vault-hint-icon" aria-hidden="true" />Encrypted at rest; anyone with the server and its key can read every secret. Names, short names, and tags are not encrypted.</p>
      <footer className="file-dialog-actions vault-settings-actions">
        {owner && <button type="button" className="danger-button" disabled={busy} onClick={() => {
          void ask({ title: `Delete ${current.name}?`, message: "The vault, its environments, and every secret move to the Bin for 30 days. Deleting it from the Bin destroys its key, so nothing can be read again.", confirmLabel: "Move to Bin", danger: true }).then(async (confirmed) => {
            if (!confirmed) return;
            setBusy(true);
            try {
              await deleteVault(vault.id);
              onDeleted();
            } catch (reason) {
              setError(messageOf(reason, "Could not delete the vault"));
              setBusy(false);
            }
          });
        }}><Trash2 />Delete vault</button>}
        <button type="button" className="secondary-button" onClick={onCancel} disabled={busy}>Done</button>
      </footer>
    </div>
  </ModalDialog>;
}
