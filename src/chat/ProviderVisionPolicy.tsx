import { useEffect, useId, useState } from "react";
import { Combobox } from "../ui/Combobox";
import { EMBEDDING_MODEL_ID, VISION_POLICY_BOUNDS, type ProviderVisionPolicy } from "../../shared/agents";
import { providerModels } from "./chatApi";

/**
 * The provider editor's "Images" group (uploads everywhere U5, operator decision Q10; admins): which of
 * the provider's models may be sent images people attach in Chat. No models (the default), every model,
 * or only a list (chips with suggestions from the provider's model list and free text, D91). Images go
 * to the provider inside the request, so only models that accept images should be marked.
 */

export type VisionMode = "off" | "all" | "models";
export type VisionDraft = { mode: VisionMode; models: string[] };

export const visionDraft = (policy: ProviderVisionPolicy | undefined): VisionDraft => ({
  mode: !policy?.enabled ? "off" : policy.models ? "models" : "all", models: policy?.models ? [...policy.models] : []
});

/** The draft as the API takes it, or the reason it cannot be saved. */
export function visionFromDraft(draft: VisionDraft): { policy: ProviderVisionPolicy } | { error: string } {
  if (draft.mode === "off") return { policy: { enabled: false, models: null } };
  if (draft.mode === "all") return { policy: { enabled: true, models: null } };
  if (draft.models.length === 0) return { error: "Add at least one model that can see images, or choose another option under Images." };
  return { policy: { enabled: true, models: draft.models } };
}

/** The provider card's one line about images. */
export function visionSummary(policy: ProviderVisionPolicy | undefined): string {
  if (!policy?.enabled) return "Not sent";
  return policy.models ? `${policy.models.length === 1 ? policy.models[0] : `${policy.models.length} models`}` : "Every model";
}

/** Suggestions from a provider's model list: its chat models (not embedding models). */
export const visionSuggestions = (models: readonly string[]) => models.filter((model) => !/embed/i.test(model) && model.length <= VISION_POLICY_BOUNDS.modelName && EMBEDDING_MODEL_ID.test(model)).slice(0, 100);

const MODES: Array<{ mode: VisionMode; label: string }> = [{ mode: "off", label: "No models" }, { mode: "all", label: "Every model" }, { mode: "models", label: "Only these" }];

export function ProviderVisionFields({ providerId, defaultModel, draft, onChange, disabled }: { providerId: string | null; defaultModel: string; draft: VisionDraft; onChange: (draft: VisionDraft) => void; disabled?: boolean }) {
  const ids = { heading: useId(), mode: useId() };
  const [suggested, setSuggested] = useState<string[]>([]);
  useEffect(() => {
    if (!providerId) return;
    let cancelled = false;
    providerModels(providerId).then((result) => { if (!cancelled) setSuggested(visionSuggestions(result.models)); }, () => undefined);
    return () => { cancelled = true; };
  }, [providerId]);
  const options = [...new Set([...(defaultModel ? [defaultModel] : []), ...suggested, ...draft.models])].map((model) => ({ value: model, label: model }));
  const set = (patch: Partial<VisionDraft>) => onChange({ ...draft, ...patch });
  return <div className="ai-knowledge-policy ai-vision-policy" role="group" aria-labelledby={ids.heading}>
    <span className="ai-label" id={ids.heading}>Images</span>
    <span className="ai-sublabel" id={ids.mode}>Models that can see images people attach in Chat</span>
    <div className="ai-segments" role="group" aria-labelledby={ids.mode}>
      {MODES.map((item) => <button key={item.mode} type="button" className={`ai-segment${draft.mode === item.mode ? " active" : ""}`} aria-pressed={draft.mode === item.mode} disabled={disabled} onClick={() => set({ mode: item.mode })}>{item.label}</button>)}
    </div>
    {draft.mode === "models" && <Combobox<string> multiple label="Models that can see images" value={draft.models} onChange={(models) => set({ models })} options={options}
      onCreate={async (text) => { const id = text.trim().slice(0, VISION_POLICY_BOUNDS.modelName); return { value: id, label: id }; }} createLabel={(text) => `Use “${text}”`}
      placeholder="Add a model…" placeholderWithValues="Add another model…" emptyText="Type a model id" maxSelected={VISION_POLICY_BOUNDS.models} disabled={disabled} backspaceRemoves={false} />}
    <p className="file-dialog-hint">Images (PNG, JPEG, GIF, WebP; up to 5 per message) are sent to this provider inside the request, only for the models marked here. Mark only models that accept images: others reject the request. PDFs and other files are never sent.</p>
  </div>;
}
