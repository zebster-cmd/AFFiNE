import { Inject, Injectable, Logger } from '@nestjs/common';

import { Config } from '../../../base';
import type { ModelFullConditions } from './types';

type Scenario = 'chat' | 'image' | 'embedding' | 'rerank' | 'transcript';

const FEATURE_KIND_TO_SCENARIO: Record<string, Scenario> = {
  chat: 'chat',
  action: 'chat',
  image: 'image',
  embedding: 'embedding',
  // Background doc/file indexing embeds under its own feature kind but must
  // use the same embedding model as everything else.
  workspace_indexing: 'embedding',
  rerank: 'rerank',
  transcript: 'transcript',
};

@Injectable()
export class ScenarioModelResolver {
  @Inject() private readonly AFFiNEConfig!: Config;
  private readonly logger = new Logger(ScenarioModelResolver.name);

  // Test constructor injection convenience.
  constructor(config?: Config) {
    if (config) {
      this.AFFiNEConfig = config;
    }
  }

  modelForFeatureKind(featureKind?: string): string | undefined {
    const overrides = this.AFFiNEConfig.copilot.scenarioOverrides;
    if (!overrides?.enabled || !featureKind) {
      return undefined;
    }
    const scenario = FEATURE_KIND_TO_SCENARIO[featureKind];
    return scenario ? overrides.models[scenario] : undefined;
  }

  resolve(
    cond: ModelFullConditions,
    featureKind?: string
  ): ModelFullConditions {
    const modelId = this.modelForFeatureKind(featureKind);
    if (!modelId) {
      return cond;
    }
    // Chat has a user-facing model picker, so a genuinely requested model must
    // win. Three cases:
    // 1. modelSource === 'user': an explicit picker/caller choice — keep it.
    // 2. modelId set without modelSource: treated as explicit for back-compat
    //    with callers that predate the marker — keep it.
    // 3. modelSource === 'promptDefault': the model is only a prompt-baked
    //    default (built-in prompts pin AFFiNE Cloud models), so reroute it to
    //    the configured scenario model.
    // Non-chat scenarios (image / embedding / rerank / transcript) have no
    // picker, so the override stays a hard force.
    const scenario = featureKind
      ? FEATURE_KIND_TO_SCENARIO[featureKind]
      : undefined;
    if (
      scenario === 'chat' &&
      cond.modelId &&
      cond.modelSource !== 'promptDefault'
    ) {
      return cond;
    }
    return { ...cond, modelId };
  }

  warnUnknownModels(known: Set<string>): string[] {
    const overrides = this.AFFiNEConfig.copilot.scenarioOverrides;
    if (!overrides?.enabled) {
      return [];
    }
    const missing = Object.values(overrides.models).filter(
      (m): m is string => !!m && !known.has(m)
    );
    for (const m of missing) {
      this.logger.warn(
        `scenarioOverrides model "${m}" is not in the copilot model registry; requests for it will fail.`
      );
    }
    return missing;
  }
}
