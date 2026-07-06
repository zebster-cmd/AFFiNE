import { Inject, Injectable } from '@nestjs/common';

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
    if (cond.modelId) {
      return cond;
    }
    const modelId = this.modelForFeatureKind(featureKind);
    return modelId ? { ...cond, modelId } : cond;
  }
}
