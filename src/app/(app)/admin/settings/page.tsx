"use client";

import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../../../../convex/_generated/api";
import { AdminNav } from "@/components/admin/admin-nav";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LoadingSpinner } from "@/components/shared/loading-spinner";
import { Eye, EyeOff, Save, Loader2, CheckCircle } from "lucide-react";

function ApiKeyField({
  label,
  description,
  isSet,
  onSave,
}: {
  label: string;
  description: string;
  isSet: boolean;
  onSave: (value: string) => Promise<void>;
}) {
  const [value, setValue] = useState("");
  const [visible, setVisible] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const handleSave = async () => {
    if (!value.trim()) return;
    setSaving(true);
    setSaved(false);
    try {
      await onSave(value.trim());
      setValue("");
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2">
      <Label className="text-sm font-medium">{label}</Label>
      <p className="text-xs text-muted-foreground">{description}</p>
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Input
            type={visible ? "text" : "password"}
            placeholder={isSet ? "••••••••••••••••  (key is set — enter new value to replace)" : "Enter API key..."}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="pr-10 font-mono text-sm"
          />
          <button
            type="button"
            onClick={() => setVisible((v) => !v)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
        <Button
          onClick={handleSave}
          disabled={saving || !value.trim()}
          variant={saved ? "outline" : "default"}
          className="shrink-0"
        >
          {saving ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : saved ? (
            <><CheckCircle className="h-4 w-4 mr-1 text-green-500" /> Saved</>
          ) : (
            <><Save className="h-4 w-4 mr-1" /> Save</>
          )}
        </Button>
      </div>
      {isSet && (
        <p className="text-xs text-green-600 dark:text-green-400 flex items-center gap-1">
          <CheckCircle className="h-3 w-3" /> Key is configured and active
        </p>
      )}
    </div>
  );
}

export default function AdminSettingsPage() {
  const status = useQuery(api.admin.platformSettings.getStatus);
  const updateSettings = useMutation(api.admin.platformSettings.update);

  if (status === undefined) {
    return (
      <div className="max-w-6xl mx-auto space-y-8">
        <AdminNav />
        <div className="flex h-64 items-center justify-center">
          <LoadingSpinner />
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <AdminNav />

      <div>
        <h1 className="text-2xl font-bold">Platform Settings</h1>
        <p className="text-muted-foreground text-sm mt-1">
          API keys for platform-wide AI features. These are used by the platform, not individual users.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>DeepSeek — AI Assistant</CardTitle>
          <CardDescription>
            Powers the in-app AI assistant for all users. Your key, your cost.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ApiKeyField
            label="API Key"
            description="Get your key at platform.deepseek.com. Used for the AI chat assistant feature on Pro and Elite plans."
            isSet={status.deepseekKeySet}
            onSave={(key) => updateSettings({ deepseekApiKey: key })}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Gemini — Metadata Generation</CardTitle>
          <CardDescription>
            Powers AI title, description, and tag generation after video uploads. Your key, your cost.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ApiKeyField
            label="API Key"
            description="Get your key at aistudio.google.com. Used for metadata generation on all plans. Falls back to GEMINI_API_KEY env var if not set here."
            isSet={status.geminiKeySet}
            onSave={(key) => updateSettings({ geminiApiKey: key })}
          />
        </CardContent>
      </Card>
    </div>
  );
}
