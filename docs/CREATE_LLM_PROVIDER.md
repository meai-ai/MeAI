# Creating an LLM Provider

LLM Providers let MeAI use different language model backends — Anthropic API, Claude CLI, OpenAI, Ollama, Groq, local llama.cpp, etc.

## Quick Start

1. Create `src/llm/<your-provider>/index.ts`
2. Export a default `LLMProvider` instance
3. Configure in `config.json`: `"llm": { "background": "your-provider" }`

## LLMProvider Interface

```typescript
interface LLMProvider {
  readonly id: string;        // "ollama", "groq"
  readonly name: string;      // "Ollama (Local LLM)"
  readonly roles: LLMRole[];  // ["conversation", "background", "vision", "embedding"]

  init?(config: AppConfig): void | Promise<void>;
  isAvailable(): boolean;

  complete(opts: CompleteOptions): Promise<string>;  // Required
  stream?(opts: CompleteOptions): AsyncIterable<string>;  // For conversation
  describeImage?(image: Buffer | string, prompt: string): Promise<string>;  // Vision
  embed?(text: string): Promise<number[]>;  // Embeddings
}
```

## Roles

| Role | Used For |
|------|----------|
| `conversation` | Real-time chat (streaming preferred) |
| `background` | Heartbeat, emotion, curiosity, schedule generation |
| `vision` | Image description |
| `embedding` | Semantic memory search |

## Config

```json
{
  "llm": {
    "conversation": "anthropic-api",
    "background": "claude-cli",
    "embedding": "anthropic-api",
    "vision": "anthropic-api"
  }
}
```

For fully local:
```json
{
  "llm": {
    "conversation": "ollama",
    "background": "ollama",
    "embedding": "ollama",
    "vision": "ollama"
  }
}
```

## Existing Providers

- `claude-cli` — Claude CLI (`claude --print`), Max subscription billing
- `anthropic-api` — Anthropic SDK, API key billing
- `ollama` — Local LLM via Ollama (free)

## Reference

See `src/llm/ollama/index.ts` for a simple, complete implementation.
