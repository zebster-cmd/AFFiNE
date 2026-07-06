import {
  AnthropicOfficialProvider,
  AnthropicVertexProvider,
} from './anthropic';
import { CloudflareWorkersAIProvider } from './cloudflare';
import { FalProvider } from './fal';
import { GeminiGenerativeProvider, GeminiVertexProvider } from './gemini';
import { OpenAIProvider } from './openai';
import { RequestyProvider } from './requesty';

export const CopilotProviders = [
  OpenAIProvider,
  CloudflareWorkersAIProvider,
  FalProvider,
  GeminiGenerativeProvider,
  GeminiVertexProvider,
  AnthropicOfficialProvider,
  AnthropicVertexProvider,
  RequestyProvider,
];
