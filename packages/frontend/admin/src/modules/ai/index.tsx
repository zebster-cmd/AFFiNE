import { Button } from '@affine/admin/components/ui/button';
import { Input } from '@affine/admin/components/ui/input';
import { Label } from '@affine/admin/components/ui/label';
import { Separator } from '@affine/admin/components/ui/separator';
import { Switch } from '@affine/admin/components/ui/switch';
import { useMutation } from '@affine/admin/use-mutation';
import { useQuery } from '@affine/admin/use-query';
import { cn } from '@affine/admin/utils';
import { notify } from '@affine/component';
import { UserFriendlyError } from '@affine/error';
import { appConfigQuery, updateAppConfigMutation } from '@affine/graphql';
import * as ScrollAreaPrimitive from '@radix-ui/react-scroll-area';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { Header } from '../header';

// The provider-profile id the scenario model prefixes must match. Model ids in
// scenarioOverrides are stored as `requesty/<model>`; the segment before the
// first slash must equal a provider profile id, so this MUST stay "requesty".
const REQUESTY_PROFILE_ID = 'requesty';
const DEFAULT_BASE_URL = 'https://router.requesty.ai/v1';

// Curated native variants confirmed working end-to-end via Requesty. Rendered as
// <datalist> suggestions — the field is still free-text so any Requesty model id
// works. Values include the required `requesty/` prefix.
const MODEL_SUGGESTIONS: Record<ScenarioKey, string[]> = {
  chat: ['requesty/sference/glm-5.2'],
  embedding: ['requesty/nebius/Qwen/Qwen3-Embedding-8B'],
  rerank: ['requesty/nebius/qwen/qwen3-32b'],
};

type ScenarioKey = 'chat' | 'embedding' | 'rerank';

const SCENARIOS: Array<{ key: ScenarioKey; label: string; desc: string }> = [
  { key: 'chat', label: 'Chat model', desc: 'Backs chat and writing actions.' },
  {
    key: 'embedding',
    label: 'Embedding model',
    desc: 'Backs document indexing / semantic search.',
  },
  {
    key: 'rerank',
    label: 'Rerank model',
    desc: 'Backs search result reranking.',
  },
];

interface RequestyProfile {
  id: string;
  type: string;
  config: { apiKey?: string; baseURL?: string };
}

function AiPage() {
  const { data, mutate } = useQuery({ query: appConfigQuery });
  const { trigger: saveUpdates } = useMutation({
    mutation: updateAppConfigMutation,
  });

  const copilot = useMemo(
    () => (data?.appConfig as any)?.copilot ?? {},
    [data?.appConfig]
  );

  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [baseURL, setBaseURL] = useState(DEFAULT_BASE_URL);
  const [enabled, setEnabled] = useState(false);
  const [models, setModels] = useState<Record<ScenarioKey, string>>({
    chat: '',
    embedding: '',
    rerank: '',
  });
  const [saving, setSaving] = useState(false);

  // Initialize the form from the current server config once it loads.
  useEffect(() => {
    const profiles: RequestyProfile[] = Array.isArray(
      copilot?.providers?.profiles
    )
      ? copilot.providers.profiles
      : [];
    const existing = profiles.find(p => p.id === REQUESTY_PROFILE_ID);
    // Fall back to the legacy `providers.requesty` config for the key/url so an
    // env/config.json bootstrap is reflected in the form.
    const legacy = copilot?.providers?.requesty ?? {};
    setApiKey(existing?.config?.apiKey || legacy.apiKey || '');
    setBaseURL(existing?.config?.baseURL || legacy.baseURL || DEFAULT_BASE_URL);

    const overrides = copilot?.scenarioOverrides ?? {};
    setEnabled(Boolean(overrides.enabled));
    const m = overrides.models ?? {};
    setModels({
      chat: m.chat ?? '',
      embedding: m.embedding ?? '',
      rerank: m.rerank ?? '',
    });
    // Only re-init when the underlying server config identity changes.
  }, [copilot]);

  const hasStoredKey = useMemo(() => {
    const profiles: RequestyProfile[] = Array.isArray(
      copilot?.providers?.profiles
    )
      ? copilot.providers.profiles
      : [];
    const existing = profiles.find(p => p.id === REQUESTY_PROFILE_ID);
    return Boolean(
      existing?.config?.apiKey || copilot?.providers?.requesty?.apiKey
    );
  }, [copilot]);

  const save = useCallback(async () => {
    // Guard the most common misconfiguration: routing on with no key anywhere.
    // Without this the failure only shows up later as an opaque
    // "no copilot provider available" error on the first AI request.
    if (enabled && !apiKey.trim() && !hasStoredKey) {
      notify.error({
        title: 'API key required',
        message:
          'Enter a Requesty API key before enabling scenario routing, or AI requests will fail.',
      });
      return;
    }
    setSaving(true);
    try {
      // Upsert the requesty profile, preserving any other configured profiles.
      const current: RequestyProfile[] = Array.isArray(
        copilot?.providers?.profiles
      )
        ? copilot.providers.profiles
        : [];
      const others = current.filter(p => p.id !== REQUESTY_PROFILE_ID);
      const profile: RequestyProfile = {
        id: REQUESTY_PROFILE_ID,
        type: REQUESTY_PROFILE_ID, // CopilotProviderType.Requesty === 'requesty'
        config: {
          apiKey: apiKey.trim(),
          baseURL: baseURL.trim() || DEFAULT_BASE_URL,
        },
      };
      const nextProfiles = [...others, profile];

      // Keep only non-empty scenario models.
      const nextModels: Record<string, string> = {};
      (Object.keys(models) as ScenarioKey[]).forEach(key => {
        const value = models[key].trim();
        if (value) {
          nextModels[key] = value;
        }
      });

      const response = (await saveUpdates({
        updates: [
          {
            module: 'copilot',
            key: 'providers.profiles',
            value: nextProfiles,
          },
          {
            module: 'copilot',
            key: 'scenarioOverrides',
            value: { enabled, models: nextModels },
          },
        ],
      })) as { updateAppConfig?: any };

      const saved = response?.updateAppConfig ?? {};
      await mutate((prev: { appConfig?: any } | undefined) => ({
        appConfig: { ...prev?.appConfig, ...saved },
      }));

      notify.success({
        title: 'Saved',
        message: 'Requesty settings have been saved and applied.',
      });
    } catch (e) {
      const error = UserFriendlyError.fromAny(e);
      notify.error({ title: 'Failed to save', message: error.message });
      console.error(e);
    } finally {
      setSaving(false);
    }
  }, [
    apiKey,
    baseURL,
    enabled,
    models,
    copilot,
    hasStoredKey,
    saveUpdates,
    mutate,
  ]);

  return (
    <div className="h-dvh flex-1 flex-col flex">
      <Header title="Requesty AI" />
      <ScrollAreaPrimitive.Root
        className={cn('relative overflow-hidden w-full')}
      >
        <ScrollAreaPrimitive.Viewport className="h-full w-full rounded-[inherit] [&>div]:!block">
          <div className="p-6 max-w-3xl mx-auto flex flex-col gap-5">
            <div>
              <div className="text-[20px] font-semibold">
                Requesty AI gateway
              </div>
              <p className="text-sm text-muted-foreground mt-1">
                Route the AI scenarios through the Requesty (OpenAI-compatible)
                gateway. Changes are saved to the server and applied without a
                restart, overriding any value set via environment variables.
              </p>
            </div>

            {/* Credentials */}
            <div className="flex flex-col rounded-md border py-4 gap-4">
              <div className="px-5 space-y-3">
                <Label className="text-sm font-medium">API key</Label>
                <div className="flex items-center gap-2">
                  <Input
                    type={showKey ? 'text' : 'password'}
                    className="py-2 px-3 text-base font-normal placeholder:opacity-50"
                    value={apiKey}
                    placeholder={
                      hasStoredKey ? '•••••••• (stored)' : 'rqsty-sk-…'
                    }
                    onChange={e => setApiKey(e.target.value)}
                    autoComplete="off"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setShowKey(v => !v)}
                  >
                    {showKey ? 'Hide' : 'Show'}
                  </Button>
                </div>
                <p className="text-sm text-muted-foreground">
                  Stored in the server database. Rotate the key in your Requesty
                  dashboard if it is ever exposed.
                </p>
              </div>
              <Separator />
              <div className="px-5 space-y-3">
                <Label className="text-sm font-medium">Base URL</Label>
                <Input
                  type="text"
                  className="py-2 px-3 text-base font-normal placeholder:opacity-50"
                  value={baseURL}
                  placeholder={DEFAULT_BASE_URL}
                  onChange={e => setBaseURL(e.target.value)}
                />
              </div>
            </div>

            {/* Scenario routing */}
            <div className="flex flex-col rounded-md border py-4 gap-4">
              <div className="px-5 flex justify-between items-center">
                <div>
                  <p className="text-sm font-medium">Enable scenario routing</p>
                  <p className="text-sm text-muted-foreground mt-1">
                    When on, the models below back each AI scenario.
                  </p>
                </div>
                <Switch checked={enabled} onCheckedChange={setEnabled} />
              </div>
              {SCENARIOS.map(({ key, label, desc }) => (
                <div key={key}>
                  <Separator />
                  <div className="px-5 space-y-2 pt-4">
                    <Label className="text-sm font-medium">{label}</Label>
                    <Input
                      type="text"
                      list={`requesty-models-${key}`}
                      className="py-2 px-3 text-base font-normal placeholder:opacity-50"
                      value={models[key]}
                      placeholder={MODEL_SUGGESTIONS[key][0]}
                      disabled={!enabled}
                      onChange={e =>
                        setModels(prev => ({ ...prev, [key]: e.target.value }))
                      }
                    />
                    <datalist id={`requesty-models-${key}`}>
                      {MODEL_SUGGESTIONS[key].map(m => (
                        <option key={m} value={m} />
                      ))}
                    </datalist>
                    <p className="text-sm text-muted-foreground">{desc}</p>
                  </div>
                </div>
              ))}
              <Separator />
              <div className="px-5 text-sm text-muted-foreground">
                Model ids must keep the{' '}
                <code className="font-mono">requesty/</code> prefix — it maps to
                this provider. Image and transcript are not yet supported.
              </div>
            </div>

            <div className="flex justify-end">
              <Button onClick={() => void save()} disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </div>
        </ScrollAreaPrimitive.Viewport>
        <ScrollAreaPrimitive.ScrollAreaScrollbar
          className={cn(
            'flex touch-none select-none transition-colors',
            'h-full w-2.5 border-l border-l-transparent p-[1px]'
          )}
        >
          <ScrollAreaPrimitive.ScrollAreaThumb className="relative flex-1 rounded-full bg-border" />
        </ScrollAreaPrimitive.ScrollAreaScrollbar>
        <ScrollAreaPrimitive.Corner />
      </ScrollAreaPrimitive.Root>
    </div>
  );
}

export { AiPage as Component };
