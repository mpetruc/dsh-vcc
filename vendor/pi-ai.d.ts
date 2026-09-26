// Ambient types for compiling pi-vcc's pure core modules standalone.
// Only enough of @earendil-works/pi-ai is declared here to satisfy tsc;
// the dsh glue never imports pi-ai at runtime.

declare module '@earendil-works/pi-ai' {
  export interface TextPart { type: 'text'; text: string }
  export interface ToolCallPart { type: 'toolCall'; name: string; arguments: Record<string, unknown> }
  export interface ImagePart { type: 'image'; mimeType?: string }
  export type MessageContent = string | (TextPart | ToolCallPart | ImagePart)[]
  export interface Message {
    role: string
    content?: MessageContent
    toolName: string
    toolCallId?: string
    name?: string
    [key: string]: unknown
  }
}

// Node-ish globals used by the ported core (format-recall).
declare const Buffer: any
declare const process: { cwd(): string; platform: string }

// lib es2021 lacks Intl.Segmenter (es2022); declare the subset pi-vcc uses,
// matching pi's own expectation that isWordLike is always present.
declare namespace Intl {
  class Segmenter {
    constructor(locales?: string | readonly string[] | undefined, options?: { granularity?: string })
    segment(input: string): IterableIterator<{ index: number; segment: string; isWordLike: boolean }>
  }
}
