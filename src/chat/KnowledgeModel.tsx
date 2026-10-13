import { useEffect, useId, useState, type FormEvent } from "react";
import { ModalDialog } from "../files/Dialog";
import { useConfirm } from "../ui/useConfirm";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";
import { KNOWLEDGE_BOUNDS, MODEL_CHANGE_EFFECT, takesDimensions, type KnowledgeChunkPreview, type KnowledgeDetail, type KnowledgeEmbeddingChoice } from "../../shared/knowledge";
import { messageOf } from "./chatApi";
import { changeEmbeddingModel, embeddingOptions, previewRange, sourceChunks } from "./knowledgeApi";
import { FormError } from "../ui/FormError";

/**
 * Change embedding model (2026-10-08, the base's owner): a provider (pills, no native select), a
 * model id with the provider's known embedding models as suggestions, and dimensions for models that
 * take them. Continue asks in the app's own confirm (D91) what the change costs; the sheet and the
 * confirm close on Back first. Since 2026-10-08 only what the admin's knowledge policy allows: the
 * allowed providers, a provider's model list with no free text when the admin set one, and the
 * dimensions capped at the provider's limit (`sheetChoice`).
 */
export function ModelSheet({ kb, onClose, onChanged }: { kb: KnowledgeDetail; onClose: () => void; onChanged: (kb: KnowledgeDetail, sources: number) => void }) {
  const [providers, setProviders] = useState<KnowledgeEmbeddingChoice[] | null>(null);
  const [providerId, setProviderId] = useState<string | null>(null);
  const [model, setModel] = useState(kb.embeddingModel);
  const [dims, setDims] = useState(String(kb.dims));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = useConfirm();
  const ids = { model: useId(), dims: useId() };
  useHistoryDialogGuard(true, onClose, { blocked: busy });
  useEffect(() => {
    let cancelled = false;
    embeddingOptions(kb.id).then((result) => {
      if (cancelled) return;
      setProviders(result.providers);
      // The base's own provider when it still exists, else the default (the way out of "provider removed").
      const own = result.providers.find((provider) => provider.id === result.current.providerId);
      const chosen = own ?? result.providers.find((provider) => provider.isDefault) ?? result.providers[0] ?? null;
      setProviderId(chosen?.id ?? null);
      if (chosen) {
        const start = sheetChoice(chosen, own ? { model: kb.embeddingModel, dims: kb.dims } : null);
        setModel(start.model);
        setDims(String(start.dims));
      }
    }, (reason) => { if (!cancelled) setError(messageOf(reason, "Could not load the providers")); });
    return () => { cancelled = true; };
  }, [kb.id]);
  const provider = providers?.find((item) => item.id === providerId) ?? null;
  const sized = takesDimensions(model.trim());
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!provider) return setError("Choose a provider.");
    const name = model.trim();
    if (!name) return setError("Enter a model.");
    const size = sized ? Number(dims) : null;
    if (!provider.anyModel && !provider.models?.includes(name)) return setError("Choose one of the models an admin allows with this provider.");
    if (sized && (!Number.isInteger(size) || size! < 64 || size! > provider.maxDims)) return setError(`Dimensions must be a whole number from 64 to ${provider.maxDims}.`);
    setError(null);
    const count = kb.sourceCount - kb.counts.unavailable;
    const ok = await confirm.ask({
      title: `Change to ${name}?`,
      message: `${count} ${count === 1 ? "source is" : "sources are"} embedded again with ${provider.name} · ${name}${sized ? `, ${size} dimensions` : ""}. ${MODEL_CHANGE_EFFECT}`,
      confirmLabel: "Change model",
      danger: true
    });
    if (!ok) return;
    setBusy(true);
    try {
      const result = await changeEmbeddingModel(kb.id, { providerId: provider.id, model: name, ...(sized ? { dims: size } : {}) });
      onChanged(result.knowledgeBase, result.sources);
    } catch (reason) {
      setError(messageOf(reason, "Could not change the model"));
      setBusy(false);
    }
  }
  return <ModalDialog title="Change embedding model" eyebrow={kb.name} onClose={onClose} busy={busy} variant="sheet" className="chat-dialog knowledge-sheet knowledge-model">
    <form className="file-dialog-form" onSubmit={submit} noValidate>
      <FormError message={error} />
      <p className="file-dialog-hint">Now: {kb.providerName ?? "a removed provider"} · {kb.embeddingModel}, {kb.dims} dimensions.</p>
      <span className="knowledge-field-label" id={`${ids.model}-providers`}>Provider</span>
      {providers === null ? <p className="chat-muted" role="status">Loading…</p>
        : providers.length === 0 ? <p className="chat-muted">No model provider is available for knowledge bases; an admin sets one in Settings → AI → Model providers.</p>
        : <div className="knowledge-modes" role="group" aria-labelledby={`${ids.model}-providers`}>
          {providers.map((item) => <button key={item.id} type="button" className={`knowledge-mode${item.id === providerId ? " active" : ""}`} aria-pressed={item.id === providerId}
            onClick={() => { setProviderId(item.id); if (item.id !== providerId) { setModel(item.embeddingModel); setDims(String(item.embeddingDims)); } }}>{item.name}{item.isDefault ? " (default)" : ""}</button>)}
        </div>}
      {provider && !provider.anyModel ? <>
        <span className="knowledge-field-label" id={ids.model}>Model</span>
        <div className="knowledge-modes" role="group" aria-labelledby={ids.model}>
          {(provider.models ?? []).map((name) => <button key={name} type="button" className={`knowledge-mode${name === model.trim() ? " active" : ""}`} aria-pressed={name === model.trim()} onClick={() => setModel(name)}>{name}</button>)}
        </div>
        <p className="file-dialog-hint">An admin allows only these embedding models with {provider.name}.</p>
      </> : <>
        <label htmlFor={ids.model}>Model</label>
        <input id={ids.model} value={model} maxLength={KNOWLEDGE_BOUNDS.modelName} autoComplete="off" spellCheck={false} onChange={(event) => setModel(event.target.value)} />
        {provider?.models && provider.models.length > 0 && <div className="knowledge-modes" role="group" aria-label="Embedding models this provider lists">
          {provider.models.map((name) => <button key={name} type="button" className={`knowledge-mode${name === model.trim() ? " active" : ""}`} aria-pressed={name === model.trim()} onClick={() => setModel(name)}>{name}</button>)}
        </div>}
      </>}
      {sized ? <>
        <label htmlFor={ids.dims}>Dimensions</label>
        <input id={ids.dims} type="number" inputMode="numeric" min={64} max={provider?.maxDims ?? 3072} step={1} value={dims} onChange={(event) => setDims(event.target.value)} aria-describedby={`${ids.dims}-limit`} />
        <p className="file-dialog-hint" id={`${ids.dims}-limit`}>{dimsLimitText(provider?.maxDims ?? 3072)}</p>
      </> : <p className="file-dialog-hint">This model answers in its own size; the knowledge base adopts it{provider && provider.maxDims < 3072 ? ` (at most ${provider.maxDims.toLocaleString("en-US")}, an admin's limit: a larger answer stops indexing with an error)` : ""}.</p>}
      <p className="file-dialog-hint">{MODEL_CHANGE_EFFECT}</p>
      <footer className="file-dialog-actions">
        <button type="button" className="action-button secondary" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="submit" className="action-button" disabled={busy || !provider}>{busy ? "Changing…" : "Continue"}</button>
      </footer>
    </form>
    {confirm.confirmElement}
  </ModalDialog>;
}

/** The dimensions field's line (2026-10-08): the range, and whose limit it is when the admin set one. */
export const dimsLimitText = (maxDims: number) => maxDims < 3072 ? `64 to ${maxDims.toLocaleString("en-US")}: an admin's limit for this provider.` : "64 to 3,072.";

/**
 * Where the sheet starts for a provider (2026-10-08): the base's own model and size when the policy
 * still allows them, else the provider's (already allowed) defaults, the size at most the limit.
 */
export function sheetChoice(choice: KnowledgeEmbeddingChoice, current: { model: string; dims: number } | null): { model: string; dims: number } {
  if (!current) return { model: choice.embeddingModel, dims: choice.embeddingDims };
  const allowed = choice.anyModel || (choice.models ?? []).includes(current.model);
  return { model: allowed ? current.model : choice.embeddingModel, dims: Math.min(current.dims, choice.maxDims) };
}

/**
 * A source's chunk previews (2026-10-08): its heading paths and the first 300 characters of each
 * chunk, 20 at a time with Show more. Only offered to the owner and managers who can read the source.
 */
export function SourceChunks({ kbId, sourceId, label }: { kbId: string; sourceId: string; label: string }) {
  const [chunks, setChunks] = useState<KnowledgeChunkPreview[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function load(offset: number) {
    setBusy(true);
    try {
      const page = await sourceChunks(kbId, sourceId, offset);
      setChunks((current) => offset === 0 ? page.chunks : [...current, ...page.chunks]);
      setTotal(page.total);
      setError(null);
    } catch (reason) {
      setError(messageOf(reason, "Could not load the passages"));
    } finally {
      setBusy(false);
    }
  }
  // The first page when the preview opens.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load(0); }, [kbId, sourceId]);
  return <div className="knowledge-chunks" aria-label={`Passages of ${label}`} role="region">
    <FormError message={error} />
    {total === null ? !error && <p className="chat-muted" role="status">Loading…</p> : <>
      <p className="chat-muted knowledge-chunks-count">{previewRange({ offset: 0, total }, chunks.length)}</p>
      {chunks.length > 0 && <ol className="knowledge-chunk-list">
        {chunks.map((chunk) => <li key={chunk.ord} className="knowledge-chunk">
          <strong>{chunk.heading ?? "(no heading)"}</strong>
          <p>{chunk.preview}{chunk.chars > chunk.preview.length ? "…" : ""}</p>
        </li>)}
      </ol>}
      {chunks.length < total && <button type="button" className="action-button secondary" disabled={busy} onClick={() => { void load(chunks.length); }}>{busy ? "Loading…" : "Show more"}</button>}
    </>}
  </div>;
}
