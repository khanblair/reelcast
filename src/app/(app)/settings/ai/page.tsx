"use client";

import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../../../../convex/_generated/api";
import { Sparkles, Save, Loader2 } from "lucide-react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select } from "@/components/ui/select";
import { ModelSelector } from "@/components/generation/model-selector";
import {
  VEO_RESOLUTIONS,
  VEO_ASPECT_RATIOS,
  VEO_DURATIONS,
  AI_TONES,
  AI_LANGUAGES,
  AI_DESCRIPTION_LENGTHS,
  type VeoModelKey,
} from "@/lib/constants";

export default function AISettingsPage() {
  const settings = useQuery(api.settings.get);
  const updateSettings = useMutation(api.settings.update);

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const [veoModel, setVeoModel] = useState<VeoModelKey>((settings?.veoModel as VeoModelKey) ?? "veo-2");
  const [veoResolution, setVeoResolution] = useState(settings?.veoResolution ?? "720p");
  const [veoAspectRatio, setVeoAspectRatio] = useState(settings?.veoAspectRatio ?? "16:9");
  const [veoDurationSeconds, setVeoDurationSeconds] = useState(settings?.veoDurationSeconds ?? 8);
  const [veoEnhancePrompt, setVeoEnhancePrompt] = useState(settings?.veoEnhancePrompt ?? true);

  const [aiAutoGenerate, setAiAutoGenerate] = useState(settings?.aiAutoGenerate ?? true);
  const [aiGenerateTitle, setAiGenerateTitle] = useState(settings?.aiGenerateTitle ?? true);
  const [aiGenerateDescription, setAiGenerateDescription] = useState(settings?.aiGenerateDescription ?? true);
  const [aiGenerateTags, setAiGenerateTags] = useState(settings?.aiGenerateTags ?? true);
  const [aiTone, setAiTone] = useState(settings?.aiTone ?? "professional");
  const [aiLanguage, setAiLanguage] = useState(settings?.aiLanguage ?? "en");
  const [aiDescriptionLength, setAiDescriptionLength] = useState(settings?.aiDescriptionLength ?? "medium");
  const [aiGuidelines, setAiGuidelines] = useState(settings?.aiGuidelines ?? "");

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    try {
      await updateSettings({
        veoModel,
        veoResolution,
        veoAspectRatio,
        veoDurationSeconds,
        veoEnhancePrompt,
        aiAutoGenerate,
        aiGenerateTitle,
        aiGenerateDescription,
        aiGenerateTags,
        aiTone,
        aiLanguage,
        aiDescriptionLength,
        aiGuidelines: aiGuidelines.trim() || undefined,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      console.error("Failed to save settings:", err);
    } finally {
      setSaving(false);
    }
  };

  if (settings === undefined) {
    return (
      <div className="max-w-3xl mx-auto p-6">
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Sparkles className="h-6 w-6 text-primary" />
          AI Settings
        </h1>
        <p className="text-muted-foreground mt-1">
          Configure default settings for video generation and metadata. Override per-video when generating.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Default Veo Model</CardTitle>
          <CardDescription>The model used by default when generating videos</CardDescription>
        </CardHeader>
        <CardContent>
          <ModelSelector value={veoModel} onChange={setVeoModel} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Video Generation Defaults</CardTitle>
          <CardDescription>Applied to every new generation unless overridden</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label className="text-sm font-medium">Resolution</Label>
              <Select value={veoResolution} onChange={(e) => setVeoResolution(e.target.value)}>
                {VEO_RESOLUTIONS.map((r) => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </Select>
            </div>
            <div className="space-y-2">
              <Label className="text-sm font-medium">Aspect Ratio</Label>
              <Select value={veoAspectRatio} onChange={(e) => setVeoAspectRatio(e.target.value)}>
                {VEO_ASPECT_RATIOS.map((ar) => (
                  <option key={ar.value} value={ar.value}>{ar.label}</option>
                ))}
              </Select>
            </div>
          </div>

          <div className="space-y-2">
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

          <div className="flex items-center justify-between rounded-lg border p-3 max-w-xs">
            <div>
              <Label className="text-sm font-medium">Enhance Prompt</Label>
              <p className="text-[11px] text-muted-foreground">AI improves your prompts</p>
            </div>
            <Switch checked={veoEnhancePrompt} onCheckedChange={setVeoEnhancePrompt} />
          </div>

          <p className="text-xs text-muted-foreground">
            Audio generation and person generation controls require Vertex AI (Enterprise) and are not available via the Gemini Developer API.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Metadata Generation Defaults</CardTitle>
          <CardDescription>How AI generates titles, descriptions, and tags for your videos</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between rounded-lg border p-3">
            <div>
              <Label className="text-sm font-medium">Auto-generate metadata</Label>
              <p className="text-[11px] text-muted-foreground">Run automatically after generation</p>
            </div>
            <Switch checked={aiAutoGenerate} onCheckedChange={setAiAutoGenerate} />
          </div>

          <div className="grid grid-cols-3 gap-3">
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

          <div className="grid sm:grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label className="text-sm font-medium">Tone</Label>
              <p className="text-[11px] text-muted-foreground">Voice/energy of titles and descriptions</p>
              <Select value={aiTone} onChange={(e) => setAiTone(e.target.value)}>
                {AI_TONES.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </Select>
            </div>
            <div className="space-y-2">
              <Label className="text-sm font-medium">Language</Label>
              <p className="text-[11px] text-muted-foreground">Output language for metadata</p>
              <Select value={aiLanguage} onChange={(e) => setAiLanguage(e.target.value)}>
                {AI_LANGUAGES.map((l) => (
                  <option key={l.value} value={l.value}>{l.label}</option>
                ))}
              </Select>
            </div>
            <div className="space-y-2">
              <Label className="text-sm font-medium">Description Length</Label>
              <p className="text-[11px] text-muted-foreground">How detailed descriptions are</p>
              <Select value={aiDescriptionLength} onChange={(e) => setAiDescriptionLength(e.target.value)}>
                {AI_DESCRIPTION_LENGTHS.map((d) => (
                  <option key={d.value} value={d.value}>{d.label}</option>
                ))}
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label className="text-sm font-medium">Channel Guidelines</Label>
            <p className="text-[11px] text-muted-foreground">
              Tell the AI about your channel — niche, audience, recurring themes, things to always or never include. This is injected into every metadata generation prompt.
            </p>
            <textarea
              value={aiGuidelines}
              onChange={(e) => setAiGuidelines(e.target.value)}
              placeholder={`e.g. "This is a faith-based motivational channel targeting young African professionals. Always reference resilience and purpose. Avoid political topics. Titles should feel urgent and personal."`}
              rows={4}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-none placeholder:text-muted-foreground/60"
            />
            <p className="text-[11px] text-muted-foreground">
              {aiGuidelines.length}/500 characters
            </p>
          </div>
        </CardContent>
      </Card>

      <Button onClick={handleSave} disabled={saving} className="w-full font-semibold h-11">
        {saving ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Saving...
          </>
        ) : saved ? (
          "Saved!"
        ) : (
          <>
            <Save className="mr-2 h-4 w-4" />
            Save Defaults
          </>
        )}
      </Button>
    </div>
  );
}
