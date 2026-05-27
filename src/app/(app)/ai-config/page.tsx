"use client";

import { useQuery, useMutation } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { Wand2, Save } from "lucide-react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/shared/loading-spinner";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select } from "@/components/ui/select";
import { AI_PRESETS, OUTPUT_QUALITY, ASPECT_RATIOS } from "@/lib/constants";
import { useState } from "react";

interface AISettings {
  aiPreset?: string;
  defaultQuality?: string;
  defaultAspectRatio?: string;
  defaultCaptions?: boolean;
  defaultBackgroundMusic?: boolean;
  [key: string]: unknown;
}

export default function AIConfigPage() {
  const settings = useQuery(api.settings.get);
  const updateSettings = useMutation(api.settings.update);
  const [saving, setSaving] = useState(false);

  const [localSettings, setLocalSettings] = useState<AISettings | null>(null);

  if (settings === undefined) {
    return <div className="flex h-[80vh] items-center justify-center"><LoadingSpinner /></div>;
  }

  // Initialize local settings once loaded
  if (settings && localSettings === null) {
    setLocalSettings(settings);
  }

  const currentSettings = (localSettings || settings || {}) as AISettings;

  const handleSave = async () => {
    setSaving(true);
    const s = currentSettings as AISettings;
    try {
      await updateSettings({
        aiPreset: s.aiPreset ?? undefined,
        defaultQuality: s.defaultQuality ?? undefined,
        defaultAspectRatio: s.defaultAspectRatio ?? undefined,
        defaultCaptions: s.defaultCaptions ?? undefined,
        defaultBackgroundMusic: s.defaultBackgroundMusic ?? undefined,
      });
      alert("AI settings saved successfully.");
    } catch (e) {
      console.error(e);
      alert("Failed to save AI settings.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto py-4 sm:py-8 space-y-8">
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight mb-2">AI Configuration</h1>
        <p className="text-muted-foreground">Manage global defaults for all AI video generation tasks.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Wand2 className="h-5 w-5 text-primary" />
            Global AI Defaults
          </CardTitle>
          <CardDescription>These preferences will be applied by default to all new uploads.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-2 max-w-sm">
            <Label>Default Style Preset</Label>
            <Select 
              value={currentSettings.aiPreset || AI_PRESETS[0].value}
              onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setLocalSettings({ ...currentSettings, aiPreset: e.target.value })}
            >
              {AI_PRESETS.map((p) => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </Select>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-md">
            <div className="space-y-2">
              <Label>Default Quality</Label>
              <Select 
                value={currentSettings.defaultQuality || OUTPUT_QUALITY[1].value}
                onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setLocalSettings({ ...currentSettings, defaultQuality: e.target.value })}
              >
                {OUTPUT_QUALITY.map((q) => (
                  <option key={q.value} value={q.value}>{q.label}</option>
                ))}
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Default Aspect Ratio</Label>
              <Select 
                value={currentSettings.defaultAspectRatio || ASPECT_RATIOS[0].value}
                onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setLocalSettings({ ...currentSettings, defaultAspectRatio: e.target.value })}
              >
                {ASPECT_RATIOS.map((r) => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </Select>
            </div>
          </div>
          
          <div className="flex items-center justify-between max-w-md pt-2">
            <div className="space-y-0.5">
              <Label>Generate Captions by Default</Label>
              <p className="text-sm text-muted-foreground">Auto-generate burned in captions</p>
            </div>
            <Switch 
              checked={currentSettings.defaultCaptions ?? true}
              onCheckedChange={(c) => setLocalSettings({ ...currentSettings, defaultCaptions: c })}
            />
          </div>

          <div className="flex items-center justify-between max-w-md pt-2">
            <div className="space-y-0.5">
              <Label>Add Background Music</Label>
              <p className="text-sm text-muted-foreground">Mix subtle background tracks by default</p>
            </div>
            <Switch 
              checked={currentSettings.defaultBackgroundMusic ?? false}
              onCheckedChange={(c) => setLocalSettings({ ...currentSettings, defaultBackgroundMusic: c })}
            />
          </div>
        </CardContent>
        <CardFooter>
          <Button variant="default" onClick={handleSave} disabled={saving}>
            <Save className="mr-2 h-4 w-4" /> 
            {saving ? "Saving..." : "Save Preferences"}
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
