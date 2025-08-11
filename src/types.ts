export interface ContentBlock {
  type: "text" | "image" | "document" | "tool_use" | "tool_result";
  text?: string;
  source?: {
    type: "base64" | "file";
    media_type?: string;
    data?: string;
    file_id?: string;
  };
  cache_control?: any;
  // Tool use fields
  id?: string;
  name?: string;
  input?: Record<string, any>;
  // Tool result fields
  tool_use_id?: string;
  content?: string | ContentBlock[];
}

export interface AnthropicMessage {
  role: "system" | "user" | "assistant" | string;
  content: string | ContentBlock[];
  name?: string;
}

export interface Tool {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, any>;
    required?: string[];
  };
}

export interface ToolChoice {
  type: "auto" | "any" | "tool";
  name?: string;
}

export interface AnthropicRequest {
  model?: string;
  messages: AnthropicMessage[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  stream?: boolean;
  system?: string | any[];
  conversation_id?: string; // optional session key from client
  file_ids?: string[]; // optional file ids from /v1/files
  tools?: Tool[];
  tool_choice?: ToolChoice | string;
  metadata?: any;
}

export interface AnthropicResponse {
  id: string;
  type: string;
  role: string;
  content: Array<{
    type: string;
    text: string;
  }>;
  model: string;
  stop_reason: string | null;
  stop_sequence: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

export interface AnthropicCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  completion: string;
  stop_reason?: string | null;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}
