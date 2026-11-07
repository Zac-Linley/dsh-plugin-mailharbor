import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * The slice of the DSH plugin context this package uses.
 *
 * Types are declared locally so the plugin keeps zero `@deepseek-ai/*` runtime
 * dependencies; the shapes mirror the public Cordis services of DSH 0.2.x.
 */
export interface DshRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
  resource?: (request: Request) => Promise<Response> | Response
}

export interface DshWebServer {
  register(route: DshRoute): () => void
  readonly port?: number
  readonly protocol?: string
}

export interface DshToolExec {
  signal: AbortSignal
}

export interface DshToolDefinition {
  name: string
  description: string
  /** JSON Schema for the model-facing arguments. */
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    render: (args: unknown, value: unknown) => { type: 'text'; text: string }[]
  }
  timeoutMs?: number
  isConcurrencySafe?: () => boolean
  presentCall?: (args: unknown) => Record<string, unknown>
  execute: (args: unknown, exec: DshToolExec) => Promise<unknown>
}

export interface DshTools {
  register(definition: DshToolDefinition): () => void
}

export interface DshLlmChunk {
  type: string
  text?: string
  reason?: {
    kind?: string
    failure?: { message?: string; code?: string }
  }
}

export interface DshLlm {
  stream(options: {
    provider: string
    model: string
    messages: { role: string; content: { type: string; text: string }[] }[]
    signal?: AbortSignal
  }): AsyncIterable<DshLlmChunk>
  listProviders(): { id: string; name?: string }[]
  listModels(provider: string): Promise<{ id: string; name?: string }[]>
}

export interface DshWorkspace {
  id?: string
  title?: string
}

export interface DshWorkspaceRegistry {
  create(path: string, title: string): Promise<DshWorkspace | undefined>
}

export interface DshSession {
  append(type: string, data: unknown, options?: unknown): void
}

export interface DshSessions {
  create(id: string, options?: { meta?: { cwd?: string } }): DshSession
}

export interface DshContext {
  webServer: DshWebServer
  tools: DshTools
  /** Cordis service lookup; returns undefined when the service is absent. */
  get?: (name: string) => unknown
  /** Project grouping service, when the composition mounts it. */
  workspaceRegistry?: DshWorkspaceRegistry
  /** Session service, when the composition mounts it. */
  sessions?: DshSessions
  effect?: (effect: () => (() => void) | void, label?: string) => void
  logger?: (name: string) => {
    info(message: string): void
    warn(message: string): void
    error(message: string): void
  }
}
