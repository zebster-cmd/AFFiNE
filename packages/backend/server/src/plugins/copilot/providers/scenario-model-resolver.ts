import { Inject, Injectable, Logger } from '@nestjs/common';

import { Config } from '../../../base';
import type { ModelFullConditions } from './types';

type Scenario = 'chat' | 'image' | 'embedding' | 'rerank' | 'transcript';

const FEATURE_KIND_TO_SCENARIO: Record<string, Scenario> = {
  chat: 'chat',
  action: 'chat',
  image: 'image',
  embedding: 'embedding',
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
    // Chat has a user-facing model picker, so an explicit selection must win:
    // the configured scenario model acts as the default, applied only when the
    // request carries no model of its own. Non-chat scenarios (image /
    // embedding / rerank / transcript) have no picker, so the override stays a
    // hard force.
    const scenario = featureKind
      ? FEATURE_KIND_TO_SCENARIO[featureKind]
      : undefined;
    if (scenario === 'chat' && cond.modelId) {
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
