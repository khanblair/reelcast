"use client";

import { useState } from "react";
import { useQuery, useMutation, useAction } from "convex/react";
import { api } from "../../../../../convex/_generated/api";
import { AdminNav } from "@/components/admin/admin-nav";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LoadingSpinner } from "@/components/shared/loading-spinner";
import { Eye, EyeOff, Save, Loader2, CheckCircle, XCircle, FlaskConical } from "lucide-react";
import { cn } from "@/lib/utils";

type TestResult = { success: boolean; message: string } | null;

function ApiKeyField({
  label,
  description,
  isSet,
  onSave,
  onTest,
}: {
  label: string;
  description: string;
  isSet: boolean;
  onSave: (value: string) => Promise<void>;
  onTest?: () => Promise<TestResult>;
}) {
  const [value, setValue] = useState("");
  const [visible, setVisible] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult>(null);

  const handleSave = async () => {
    if (!value.trim()) return;
    setSaving(true);
    setSaved(false);
    setTestResult(null);
    try {
      await onSave(value.trim());
      setValue("");
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    if (!onTest) return;
    setTesting(true);
    setTestResult(null);
    try {
      const result = await onTest();
      setTestResult(result);
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="space-y-3">
      <div>
        <Label className="text-sm font-medium">{label}</Label>
        <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
      </div>

      <div className="flex gap-2">
        <div className="relative flex-1">
          <Input
            type={visible ? "text" : "password"}
            placeholder={isSet ? "••••••••••••••••  (key set — enter new value to replace)" : "Enter API key..."}
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
            <><CheckCircle className="h-4 w-4 mr-1 text-green-500" />Saved</>
          ) : (
            <><Save className="h-4 w-4 mr-1" />Save</>
          )}
        </Button>

        {onTest && (
          <Button
            onClick={handleTest}
            disabled={testing || !isSet}
            variant="outline"
            className="shrink-0"
            title={!isSet ? "Save a key first" : "Test connection"}
          >
            {testing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <><FlaskConical className="h-4 w-4 mr-1" />Test</>
            )}
          </Button>
        )}
      </div>

      {/* Status indicators */}
      {isSet && !testResult && (
        <p className="text-xs text-green-600 dark:text-green-400 flex items-center gap-1">
          <CheckCircle className="h-3 w-3" /> Key is configured
        </p>
      )}

      {testResult && (
        <div className={cn(
          "flex items-start gap-2 rounded-lg border px-3 py-2 text-xs",
          testResult.success
            ? "border-green-200 bg-green-50 text-green-700 dark:border-green-800 dark:bg-green-950/40 dark:text-green-400"
            : "border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-400"
        )}>
          {testResult.success
            ? <CheckCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            : <XCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />}
          <span>{testResult.message}</span>
        </div>
      )}
    </div>
  );
}

export default function AdminSettingsPage() {
  const status = useQuery(api.admin.platformSettings.getStatus);
  const updateSettings = useMutation(api.admin.platformSettings.update);
  const testDeepseek = useAction(api.admin.testApiKeys.testDeepseek);
  const testGemini = useAction(api.admin.testApiKeys.testGemini);

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
            Powers the in-app AI assistant for all users on Pro and Elite plans.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ApiKeyField
            label="API Key"
            description="Get your key at platform.deepseek.com. The platform covers this cost — users do not need their own key."
            isSet={status.deepseekKeySet}
            onSave={(key) => updateSettings({ deepseekApiKey: key })}
            onTest={async () => testDeepseek({})}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Gemini — Metadata Generation</CardTitle>
          <CardDescription>
            Powers AI title, description, and tag generation after video uploads.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ApiKeyField
            label="API Key"
            description="Get your key at aistudio.google.com. Falls back to GEMINI_API_KEY env var if not set here."
            isSet={status.geminiKeySet}
            onSave={(key) => updateSettings({ geminiApiKey: key })}
            onTest={async () => testGemini({})}
          />
        </CardContent>
      </Card>
    </div>
  );
}
