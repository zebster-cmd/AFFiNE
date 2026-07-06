import type { LlmBackendConfig } from '../../../native';
import { OpenAIProvider } from './openai';
import type { CopilotProviderExecution } from './provider-runtime-contract';
import { CopilotProviderType } from './types';

const REQUESTY_DEFAULT_BASE_URL = 'https://router.requesty.ai/v1';

export class RequestyProvider extends OpenAIProvider {
  override readonly type = CopilotProviderType.Requesty;

  // Requesty speaks OpenAI Chat Completions; ignore oldApiStyle.
  protected override resolveModelBackendKind() {
    return 'openai_chat' as const;
  }

  protected override createNativeConfig(
    execution?: CopilotProviderExecution
  ): LlmBackendConfig {
    const config = this.getConfig(execution);
    const baseUrl = config.baseURL || REQUESTY_DEFAULT_BASE_URL;
    return {
      base_url: baseUrl.replace(/\/v1\/?$/, ''),
      auth_token: config.apiKey,
    };
  }
}
