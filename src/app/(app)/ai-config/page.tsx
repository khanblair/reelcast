"use client";

import { useState, useEffect } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { Wand2, Save, Sparkles, Languages, FileText, BookOpen } from "lucide-react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/shared/loading-spinner";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { AI_TONES, AI_LANGUAGES, AI_DESCRIPTION_LENGTHS } from "@/lib/constants";

interface AIConfig {
  aiAutoGenerate: boolean;
  aiGenerateTitle: boolean;
  aiGenerateDescription: boolean;
  aiGenerateTags: boolean;
  aiTone: string;
  aiLanguage: string;
  aiDescriptionLength: string;
  aiGuidelines: string;
}

const DEFAULTS: AIConfig = {
  aiAutoGenerate: true,
  aiGenerateTitle: true,
  aiGenerateDescription: true,
  aiGenerateTags: true,
  aiTone: "professional",
  aiLanguage: "en",
  aiDescriptionLength: "medium",
  aiGuidelines: "",
};

export default function AIConfigPage() {
  const settings = useQuery(api.settings.get);
  const updateSettings = useMutation(api.settings.update);
  const [config, setConfig] = useState<AIConfig>(DEFAULTS);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (settings) {
      setConfig({
        aiAutoGenerate:       settings.aiAutoGenerate       ?? DEFAULTS.aiAutoGenerate,
        aiGenerateTitle:      settings.aiGenerateTitle      ?? DEFAULTS.aiGenerateTitle,
        aiGenerateDescription:settings.aiGenerateDescription?? DEFAULTS.aiGenerateDescription,
        aiGenerateTags:       settings.aiGenerateTags       ?? DEFAULTS.aiGenerateTags,
        aiTone:               (settings.aiTone as string)   ?? DEFAULTS.aiTone,
        aiLanguage:           (settings.aiLanguage as string)?? DEFAULTS.aiLanguage,
        aiDescriptionLength:  (settings.aiDescriptionLength as string) ?? DEFAULTS.aiDescriptionLength,
        aiGuidelines:         (settings.aiGuidelines as string)        ?? DEFAULTS.aiGuidelines,
      });
    }
  }, [settings]);

  if (settings === undefined) {
    return <div className="flex h-[80vh] items-center justify-center"><LoadingSpinner /></div>;
  }

  const set = <K extends keyof AIConfig>(key: K, value: AIConfig[K]) =>
    setConfig((prev) => ({ ...prev, [key]: value }));

  const handleSave = async () => {
    setSaving(true);
    try {
      await updateSettings(config);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      console.error(e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto space-y-8">
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight mb-2">AI Configuration</h1>
        <p className="text-muted-foreground">Control how AI generates metadata and content for your videos.</p>
      </div>

      {/* Metadata Generation */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" />
            Metadata Generation
          </CardTitle>
          <CardDescription>
            Choose what the AI automatically generates when you upload a video.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Auto-generate on upload</Label>
              <p className="text-sm text-muted-foreground">Run AI analysis immediately after every upload</p>
            </div>
            <Switch
              checked={config.aiAutoGenerate}
              onCheckedChange={(c) => set("aiAutoGenerate", c)}
            />
          </div>

          <div className={`space-y-4 pl-4 border-l-2 border-muted transition-opacity ${config.aiAutoGenerate ? "opacity-100" : "opacity-40 pointer-events-none"}`}>
            <div className="flex items-center justify-between max-w-md">
              <Label className="font-normal">Generate title</Label>
              <Switch
                checked={config.aiGenerateTitle}
                onCheckedChange={(c) => set("aiGenerateTitle", c)}
              />
            </div>
            <div className="flex items-center justify-between max-w-md">
              <Label className="font-normal">Generate description</Label>
              <Switch
                checked={config.aiGenerateDescription}
                onCheckedChange={(c) => set("aiGenerateDescription", c)}
              />
            </div>
            <div className="flex items-center justify-between max-w-md">
              <Label className="font-normal">Generate tags</Label>
              <Switch
                checked={config.aiGenerateTags}
                onCheckedChange={(c) => set("aiGenerateTags", c)}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Content Style */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Languages className="h-5 w-5 text-primary" />
            Content Style & Language
          </CardTitle>
          <CardDescription>
            Set the tone, language, and length for AI-generated descriptions.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid sm:grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label>Tone</Label>
              <select
                className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                value={config.aiTone}
                onChange={(e) => set("aiTone", e.target.value)}
              >
                {AI_TONES.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label>Language</Label>
              <select
                className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                value={config.aiLanguage}
                onChange={(e) => set("aiLanguage", e.target.value)}
              >
                {AI_LANGUAGES.map((l) => (
                  <option key={l.value} value={l.value}>{l.label}</option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label>Description length</Label>
              <select
                className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                value={config.aiDescriptionLength}
                onChange={(e) => set("aiDescriptionLength", e.target.value)}
              >
                {AI_DESCRIPTION_LENGTHS.map((d) => (
                  <option key={d.value} value={d.value}>{d.label}</option>
                ))}
              </select>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Custom Guidelines */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <BookOpen className="h-5 w-5 text-primary" />
            Custom Guidelines
          </CardTitle>
          <CardDescription>
            Write specific instructions the AI should follow for every video — brand voice, keywords, disclaimers, or anything else.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Textarea
            placeholder={`Examples:\n• Always start descriptions with the channel tagline\n• Include keywords: tutorial, how-to\n• End every description with a call-to-action to subscribe`}
            className="min-h-[140px] resize-y"
            value={config.aiGuidelines}
            onChange={(e) => set("aiGuidelines", e.target.value)}
          />
          <p className="text-xs text-muted-foreground mt-2">
            {config.aiGuidelines.length} / 1000 characters
          </p>
        </CardContent>
        <CardFooter className="flex items-center gap-3">
          <Button onClick={handleSave} disabled={saving}>
            {saving
              ? <><LoadingSpinner size="sm" /><span className="ml-2">Saving…</span></>
              : <><Save className="mr-2 h-4 w-4" />Save Preferences</>
            }
          </Button>
          {saved && <span className="text-sm text-success">Saved!</span>}
        </CardFooter>
      </Card>
    </div>
  );
}
