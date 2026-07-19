"use client";

import { useState, useEffect } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { X, Sparkles, Save, Loader2, Wand2, Video } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select } from "@/components/ui/select";
import { ModelSelector } from "@/components/generation/model-selector";
import {
  AI_TONES,
  AI_LANGUAGES,
  AI_DESCRIPTION_LENGTHS,
  VEO_RESOLUTIONS,
  VEO_ASPECT_RATIOS,
  VEO_DURATIONS,
  type VeoModelKey,
} from "@/lib/constants";

type Tab = "metadata" | "video";

interface AISettingsModalProps {
  open: boolean;
  onClose: () => void;
}

export function AISettingsModal({ open, onClose }: AISettingsModalProps) {
  const settings = useQuery(api.settings.get);
  const updateSettings = useMutation(api.settings.update);

  const [tab, setTab] = useState<Tab>("metadata");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Metadata state
  const [aiAutoGenerate, setAiAutoGenerate] = useState(true);
  const [aiGenerateTitle, setAiGenerateTitle] = useState(true);
  const [aiGenerateDescription, setAiGenerateDescription] = useState(true);
  const [aiGenerateTags, setAiGenerateTags] = useState(true);
  const [aiTone, setAiTone] = useState("professional");
  const [aiLanguage, setAiLanguage] = useState("en");
  const [aiDescriptionLength, setAiDescriptionLength] = useState("medium");
  const [aiGuidelines, setAiGuidelines] = useState("");

  // Video generation state
  const [veoModel, setVeoModel] = useState<VeoModelKey>("veo-2");
  const [veoResolution, setVeoResolution] = useState("720p");
  const [veoAspectRatio, setVeoAspectRatio] = useState("16:9");
  const [veoDurationSeconds, setVeoDurationSeconds] = useState(8);
  const [veoEnhancePrompt, setVeoEnhancePrompt] = useState(true);

  // Sync from loaded settings whenever modal opens
  useEffect(() => {
    if (open && settings) {
      setAiAutoGenerate(settings.aiAutoGenerate ?? true);
      setAiGenerateTitle(settings.aiGenerateTitle ?? true);
      setAiGenerateDescription(settings.aiGenerateDescription ?? true);
      setAiGenerateTags(settings.aiGenerateTags ?? true);
      setAiTone(settings.aiTone ?? "professional");
      setAiLanguage(settings.aiLanguage ?? "en");
      setAiDescriptionLength(settings.aiDescriptionLength ?? "medium");
      setAiGuidelines(settings.aiGuidelines ?? "");
      setVeoModel((settings.veoModel as VeoModelKey) ?? "veo-2");
      setVeoResolution(settings.veoResolution ?? "720p");
      setVeoAspectRatio(settings.veoAspectRatio ?? "16:9");
      setVeoDurationSeconds(settings.veoDurationSeconds ?? 8);
      setVeoEnhancePrompt(settings.veoEnhancePrompt ?? true);
    }
  }, [open, settings]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    try {
      await updateSettings({
        aiAutoGenerate,
        aiGenerateTitle,
        aiGenerateDescription,
        aiGenerateTags,
        aiTone,
        aiLanguage,
        aiDescriptionLength,
        aiGuidelines: aiGuidelines.trim() || undefined,
        veoModel,
        veoResolution,
        veoAspectRatio,
        veoDurationSeconds,
        veoEnhancePrompt,
      });
      setSaved(true);
      setTimeout(() => { setSaved(false); onClose(); }, 900);
    } catch (err) {
      console.error("Failed to save AI settings:", err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      {/* Panel */}
      <div className="relative z-50 w-full max-w-2xl mx-0 sm:mx-4 bg-card border border-border rounded-t-2xl sm:rounded-2xl shadow-2xl flex flex-col max-h-[92dvh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-5 pb-4 border-b border-border shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-primary/10">
              <Sparkles className="h-4 w-4 text-primary" />
            </div>
            <div>
              <h2 className="font-semibold text-base">AI Settings</h2>
              <p className="text-xs text-muted-foreground">Metadata generation and video defaults</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 px-5 pt-3 pb-0 shrink-0">
          <button
            type="button"
            onClick={() => setTab("metadata")}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              tab === "metadata"
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <Wand2 className="h-3.5 w-3.5" />
            Metadata
          </button>
          <button
            type="button"
            onClick={() => setTab("video")}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              tab === "video"
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <Video className="h-3.5 w-3.5" />
            Video Generation
          </button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {settings === undefined ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : tab === "metadata" ? (
            <>
              {/* Auto-generate toggle */}
              <div className="flex items-center justify-between rounded-lg border p-3">
                <div>
                  <Label className="text-sm font-medium">Auto-generate on upload</Label>
                  <p className="text-xs text-muted-foreground mt-0.5">Run automatically after each video is processed</p>
                </div>
                <Switch checked={aiAutoGenerate} onCheckedChange={setAiAutoGenerate} />
              </div>

              {/* Per-field toggles */}
              <div className="grid grid-cols-3 gap-2">
                {[
                  { label: "Title", checked: aiGenerateTitle, onChange: setAiGenerateTitle },
                  { label: "Description", checked: aiGenerateDescription, onChange: setAiGenerateDescription },
                  { label: "Tags", checked: aiGenerateTags, onChange: setAiGenerateTags },
                ].map((item) => (
                  <div key={item.label} className="flex items-center justify-between rounded-lg border p-3">
                    <Label className="text-sm">{item.label}</Label>
                    <Switch checked={item.checked} onCheckedChange={item.onChange} />
                  </div>
                ))}
              </div>

              {/* Tone / Language / Length */}
              <div className="grid sm:grid-cols-3 gap-4">
                <div className="space-y-1.5">
                  <Label className="text-sm font-medium">Tone</Label>
                  <p className="text-xs text-muted-foreground">Voice of titles & descriptions</p>
                  <Select value={aiTone} onChange={(e) => setAiTone(e.target.value)}>
                    {AI_TONES.map((t) => (
                      <option key={t.value} value={t.value}>{t.label}</option>
                    ))}
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-sm font-medium">Language</Label>
                  <p className="text-xs text-muted-foreground">Output language</p>
                  <Select value={aiLanguage} onChange={(e) => setAiLanguage(e.target.value)}>
                    {AI_LANGUAGES.map((l) => (
                      <option key={l.value} value={l.value}>{l.label}</option>
                    ))}
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-sm font-medium">Description Length</Label>
                  <p className="text-xs text-muted-foreground">How detailed</p>
                  <Select value={aiDescriptionLength} onChange={(e) => setAiDescriptionLength(e.target.value)}>
                    {AI_DESCRIPTION_LENGTHS.map((d) => (
                      <option key={d.value} value={d.value}>{d.label}</option>
                    ))}
                  </Select>
                </div>
              </div>

              {/* Channel Guidelines */}
              <div className="space-y-1.5">
                <Label className="text-sm font-medium">Channel Guidelines</Label>
                <p className="text-xs text-muted-foreground">
                  Tell the AI about your channel — niche, audience, recurring themes, things to always or never include. Injected into every metadata prompt.
                </p>
                <textarea
                  value={aiGuidelines}
                  onChange={(e) => setAiGuidelines(e.target.value)}
                  placeholder={`e.g. "Faith-based motivational content targeting young African professionals. Always reference resilience and purpose. Avoid political topics."`}
                  rows={4}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-none placeholder:text-muted-foreground/60"
                />
                <p className="text-xs text-muted-foreground text-right">{aiGuidelines.length}/500</p>
              </div>
            </>
          ) : (
            <>
              {/* Veo model */}
              <ModelSelector value={veoModel} onChange={setVeoModel} />

              {/* Resolution + Aspect Ratio */}
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label className="text-sm font-medium">Resolution</Label>
                  <Select value={veoResolution} onChange={(e) => setVeoResolution(e.target.value)}>
                    {VEO_RESOLUTIONS.map((r) => (
                      <option key={r.value} value={r.value}>{r.label}</option>
                    ))}
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-sm font-medium">Aspect Ratio</Label>
                  <Select value={veoAspectRatio} onChange={(e) => setVeoAspectRatio(e.target.value)}>
                    {VEO_ASPECT_RATIOS.map((ar) => (
                      <option key={ar.value} value={ar.value}>{ar.label}</option>
                    ))}
                  </Select>
                </div>
              </div>

              {/* Duration */}
              <div className="space-y-1.5">
                <Label className="text-sm font-medium">Default Duration</Label>
                <div className="flex gap-2">
                  {VEO_DURATIONS.map((d) => (
                    <button
                      key={d.value}
                      type="button"
                      onClick={() => setVeoDurationSeconds(d.value)}
                      className={`flex-1 rounded-md border px-3 py-2 text-sm transition-all ${
                        veoDurationSeconds === d.value
                          ? "border-primary bg-primary/5 font-medium"
                          : "border-border hover:border-primary/40"
                      }`}
                    >
                      {d.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Enhance prompt */}
              <div className="flex items-center justify-between rounded-lg border p-3">
                <div>
                  <Label className="text-sm font-medium">Enhance Prompt</Label>
                  <p className="text-xs text-muted-foreground mt-0.5">AI rewrites your prompts for better results</p>
                </div>
                <Switch checked={veoEnhancePrompt} onCheckedChange={setVeoEnhancePrompt} />
              </div>

              <p className="text-xs text-muted-foreground">
                Audio generation and person generation require Vertex AI Enterprise and are not available via the Gemini Developer API.
              </p>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-border shrink-0">
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving} className="min-w-[100px]">
            {saving ? (
              <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Saving…</>
            ) : saved ? (
              "Saved!"
            ) : (
              <><Save className="mr-2 h-4 w-4" />Save</>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
