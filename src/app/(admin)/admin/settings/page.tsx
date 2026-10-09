"use client";

import { useId, useState } from "react";
import { api, useAction, useMutation, useQuery } from "@/lib/rpc/client";
import { AdminPage } from "@/components/admin/shell/admin-page";
import { PanelSkeleton } from "@/components/admin/shell/admin-skeleton";
import { FilterChips } from "@/components/admin/billing/filters";
import { StatusDot } from "@/components/admin/billing/status-dot";
import { SectionCard } from "@/components/admin/shared/section-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Eye, EyeOff, Save, Loader2, Check, CircleAlert, FlaskConical } from "lucide-react";

type TestResult = { success: boolean; message: string } | null;

/** Outcome of a test or registration call: icon carries the tone, the message stays readable text. */
function ResultNote({ result }: { result: TestResult }) {
  if (!result) return null;
  return (
    <div
      role={result.success ? "status" : "alert"}
      className="flex items-start gap-2 rounded-lg border border-border px-3 py-2 text-xs"
    >
      {result.success ? (
        <Check aria-hidden className="mt-0.5 size-3.5 shrink-0 text-success" />
      ) : (
        <CircleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0 text-destructive" />
      )}
      <span className="min-w-0 break-words">{result.message}</span>
    </div>
  );
}

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
  const uid = useId();
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
    } catch (e) {
      setTestResult({
        success: false,
        message: e instanceof Error ? e.message : "Could not save the key.",
      });
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
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        void handleSave();
      }}
    >
      <div>
        <Label htmlFor={`${uid}-key`} className="text-sm font-medium">
          {label}
        </Label>
        <p id={`${uid}-desc`} className="mt-1 text-xs text-muted-foreground">
          {description}
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <div className="relative min-w-[200px] flex-1">
          <Input
            id={`${uid}-key`}
            name={`${uid}-key`}
            type={visible ? "text" : "password"}
            autoComplete="off"
            aria-describedby={`${uid}-desc`}
            placeholder={
              isSet
                ? "••••••••••••••••  (key set — enter new value to replace)"
                : "Enter API key..."
            }
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="pr-10 font-mono text-sm"
          />
          <button
            type="button"
            onClick={() => setVisible((v) => !v)}
            aria-label={visible ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
            aria-pressed={visible}
            className="absolute right-1.5 top-1/2 inline-flex size-7 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
          >
            {visible ? (
              <EyeOff aria-hidden className="size-4" />
            ) : (
              <Eye aria-hidden className="size-4" />
            )}
          </button>
        </div>

        <Button
          type="submit"
          disabled={saving || !value.trim()}
          variant="secondary"
          className="shrink-0"
        >
          {saving ? (
            <>
              <Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />
              Saving…
            </>
          ) : saved ? (
            <>
              <Check aria-hidden className="size-4 text-success" />
              Saved
            </>
          ) : (
            <>
              <Save aria-hidden className="size-4" />
              Save
            </>
          )}
        </Button>

        {onTest && (
          <Button
            type="button"
            onClick={handleTest}
            disabled={testing || !isSet}
            variant="outline"
            className="shrink-0"
            title={!isSet ? "Save a key first" : "Test connection"}
          >
            {testing ? (
              <>
                <Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />
                Testing…
              </>
            ) : (
              <>
                <FlaskConical aria-hidden className="size-4" />
                Test
              </>
            )}
          </Button>
        )}
      </div>

      {/* Status indicators */}
      {isSet && !testResult && (
        <StatusDot
          tone="success"
          label="Key is configured"
          className="text-xs text-muted-foreground"
        />
      )}

      <ResultNote result={testResult} />
    </form>
  );
}

export default function AdminSettingsPage() {
  const status = useQuery(api.admin.platformSettings.getStatus);
  const updateSettings = useMutation(api.admin.platformSettings.update);
  const testDeepseek = useAction(api.admin.testApiKeys.testDeepseek);
  const testGemini = useAction(api.admin.testApiKeys.testGemini);

  const settingsTitle = "Platform settings";
  const settingsDescription =
    "API keys for platform-wide AI features. These are used by the platform, not individual users.";

  if (status === undefined) {
    return (
      <AdminPage title={settingsTitle} description={settingsDescription} className="max-w-3xl">
        <PanelSkeleton lines={3} />
        <PanelSkeleton lines={3} />
        <PanelSkeleton lines={5} />
      </AdminPage>
    );
  }

  return (
    <AdminPage title={settingsTitle} description={settingsDescription} className="max-w-3xl">
      <SectionCard
        title="DeepSeek — AI assistant"
        description="Powers the in-app AI assistant for all users on Pro and Elite plans."
      >
        <div className="p-4 sm:p-5">
          <ApiKeyField
            label="API key"
            description="Get your key at platform.deepseek.com. The platform covers this cost — users do not need their own key."
            isSet={status.deepseekKeySet}
            onSave={async (key) => {
              await updateSettings({ deepseekApiKey: key });
            }}
            onTest={async () => testDeepseek({})}
          />
        </div>
      </SectionCard>

      <SectionCard
        title="Gemini — metadata generation"
        description="Powers AI title, description, and tag generation after video uploads."
      >
        <div className="p-4 sm:p-5">
          <ApiKeyField
            label="API key"
            description="Get your key at aistudio.google.com. Falls back to GEMINI_API_KEY env var if not set here."
            isSet={status.geminiKeySet}
            onSave={async (key) => {
              await updateSettings({ geminiApiKey: key });
            }}
            onTest={async () => testGemini({})}
          />
        </div>
      </SectionCard>

      <PesapalSettingsCard status={status} updateSettings={updateSettings} />
    </AdminPage>
  );
}

type UpdateSettings = (args: {
  pesapalConsumerKey?: string;
  pesapalConsumerSecret?: string;
  pesapalEnvironment?: "sandbox" | "live";
}) => Promise<unknown>;

const ENVIRONMENT_OPTIONS = [
  { value: "sandbox", label: "Sandbox" },
  { value: "live", label: "Live" },
] as const;

function PesapalSettingsCard({
  status,
  updateSettings,
}: {
  status: {
    pesapalConfigured: boolean;
    pesapalConfigSource?: string;
    pesapalConsumerKeyHint?: string;
    pesapalConsumerSecretSet: boolean;
    pesapalEnvironment: string;
    pesapalIpnRegistered: boolean;
    pesapalIpnUrl?: string;
    pesapalCurrency: string;
    appUrlConfigured: boolean;
  };
  updateSettings: UpdateSettings;
}) {
  const registerIpn = useAction(api.admin.platformSettings.registerIpn);
  const urls = useQuery(api.admin.platformSettings.getUrls);
  const [environment, setEnvironment] = useState<"sandbox" | "live">(
    status.pesapalEnvironment === "live" ? "live" : "sandbox"
  );
  const [savingEnv, setSavingEnv] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [registerResult, setRegisterResult] = useState<TestResult>(null);

  const handleEnvironmentChange = async (env: "sandbox" | "live") => {
    setEnvironment(env);
    setSavingEnv(true);
    setRegisterResult(null);
    try {
      await updateSettings({ pesapalEnvironment: env });
    } finally {
      setSavingEnv(false);
    }
  };

  const handleRegisterIpn = async () => {
    setRegistering(true);
    setRegisterResult(null);
    try {
      const r = await registerIpn({});
      setRegisterResult({
        success: true,
        message: `${r.reused ? "IPN already registered" : "IPN registered"} for ${r.ipnUrl} (${r.environment}).`,
      });
    } catch (e) {
      setRegisterResult({
        success: false,
        message: e instanceof Error ? e.message : "Registration failed.",
      });
    } finally {
      setRegistering(false);
    }
  };

  return (
    <SectionCard
      title="Pesapal — billing"
      description="Takes payments for Pro/Elite (M-Pesa, Airtel Money, cards). Get the Consumer Key and Secret from your Pesapal merchant dashboard. Changing the environment or the Consumer Key clears the IPN registration."
    >
      <div className="space-y-6 p-4 sm:p-5">
        {status.pesapalConfigSource === "environment" && (
          <p className="text-xs text-muted-foreground">
            Credentials are currently read from the PESAPAL_CONSUMER_KEY / PESAPAL_CONSUMER_SECRET
            environment variables. Saving values here overrides them.
          </p>
        )}
        <ApiKeyField
          label="Consumer key"
          description={
            status.pesapalConsumerKeyHint
              ? `Current key: ${status.pesapalConsumerKeyHint}`
              : "From the Pesapal merchant dashboard."
          }
          isSet={status.pesapalConfigured}
          onSave={async (key) => {
            await updateSettings({ pesapalConsumerKey: key });
          }}
        />
        <ApiKeyField
          label="Consumer secret"
          description="From the Pesapal merchant dashboard. Stored encrypted; it is never shown again."
          isSet={status.pesapalConsumerSecretSet}
          onSave={async (key) => {
            await updateSettings({ pesapalConsumerSecret: key });
          }}
        />

        <div className="space-y-2">
          <p className="text-sm font-medium">Environment</p>
          <FilterChips
            label="Pesapal environment"
            options={ENVIRONMENT_OPTIONS}
            value={environment}
            disabled={savingEnv}
            onChange={handleEnvironmentChange}
          />
          <p className="text-xs text-muted-foreground">
            Sandbox uses cybqa.pesapal.com with test credentials. Switch to Live only with your live
            Consumer Key and Secret. Charges are made in {status.pesapalCurrency}{" "}
            (PESAPAL_CURRENCY).
          </p>
        </div>

        <div className="space-y-2 border-t border-border pt-4">
          <p className="text-sm font-medium">IPN registration</p>
          <p className="text-xs text-muted-foreground">
            {status.pesapalIpnRegistered
              ? `Registered: ${status.pesapalIpnUrl ?? "IPN URL"}`
              : "Not registered yet. Pesapal needs your IPN URL before any checkout can be created. Save the key and secret first."}
          </p>
          {!status.appUrlConfigured && (
            <p role="alert" className="text-xs text-destructive">
              NEXT_PUBLIC_APP_URL is not set. It must be your public https URL.
            </p>
          )}
          <Button
            onClick={handleRegisterIpn}
            disabled={registering || !status.pesapalConfigured || !status.appUrlConfigured}
            variant="outline"
          >
            {registering ? (
              <Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />
            ) : null}
            {status.pesapalIpnRegistered ? "Re-register IPN" : "Register IPN"}
          </Button>
          <ResultNote result={registerResult} />
          {urls && (
            <dl className="space-y-1 pt-1 text-xs text-muted-foreground">
              <div>
                <dt className="inline font-medium">IPN URL: </dt>
                <dd className="inline break-all font-mono">{urls.ipnUrl}</dd>
              </div>
              <div>
                <dt className="inline font-medium">Customer return URL: </dt>
                <dd className="inline break-all font-mono">{urls.callbackUrl}</dd>
              </div>
            </dl>
          )}
        </div>
      </div>
    </SectionCard>
  );
}
