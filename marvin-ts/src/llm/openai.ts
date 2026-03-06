import type {
  ProviderConfig,
  Provider,
  Message,
  ChatOptions,
  ChatResult,
  ToolCall,
} from '../types.js';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export class OpenAICompatProvider implements Provider {
  readonly name: string;
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  private lastResponseId: string | null = null;

  constructor(config: ProviderConfig) {
    this.name = config.provider;
    this.model = config.model;
    this.apiKey = config.apiKey ?? '';
    this.baseUrl = (config.baseUrl ?? '').replace(/\/+$/, '');
    this.timeoutMs = config.timeoutMs;
  }

  async chat(messages: Message[], options?: ChatOptions): Promise<ChatResult> {
    if (this.name === 'openai') {
      return await this.chatResponses(messages, options);
    }
    return await this.chatCompletions(messages, options);
  }

  private async chatCompletions(messages: Message[], options?: ChatOptions): Promise<ChatResult> {
    const hasTools = options?.tools && options.tools.length > 0;
    // Force stream=false when tools are provided (tool calls can't stream reliably)
    const shouldStream = hasTools ? false : (options?.stream ?? false);

    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      stream: shouldStream,
      ...(hasTools ? { tools: options!.tools } : {}),
      ...(options?.extraBody ?? {}),
    };

    if (shouldStream) {
      body.stream_options = { include_usage: true };
    }

    // Gemini thinking config injection (only when no tools)
    if (!hasTools) {
      const thinkingConfig = this.getGeminiThinkingConfig();
      if (thinkingConfig) {
        body.extra_body = { google: { thinking_config: thinkingConfig } };
      }
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
    const signal = options?.signal
      ? anySignal([options.signal, controller.signal])
      : controller.signal;

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal,
      });

      if (!response.ok) {
        const errBody = await response.text();
        // SECURITY NOTE: errBody is truncated to 500 chars. The API key is sent via
        // Authorization header, not the body, so it should not appear in error responses.
        // If a provider ever echoes auth headers in errors, this would need scrubbing.
        throw new Error(`${response.status} ${response.statusText}: ${errBody.slice(0, 500)}`);
      }

      if (shouldStream) {
        return await this.parseStreamingResponse(response, options?.onDelta);
      } else {
        return await this.parseNonStreamingResponse(response);
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async chatResponses(messages: Message[], options?: ChatOptions): Promise<ChatResult> {
    const hasTools = options?.tools && options.tools.length > 0;
    // Force stream=false when tools are provided (tool calls can't stream reliably)
    const shouldStream = hasTools ? false : (options?.stream ?? false);

    const isToolContinuation = messages.length > 0 && messages[messages.length - 1].role === 'tool';

    const effort = this.getOpenAIReasoningEffort();
    const body: Record<string, unknown> = {
      model: this.model,
      ...(effort ? { reasoning: { effort } } : {}),
      ...(hasTools ? { tools: this.convertToolsForResponses(options!.tools!) } : {}),
      ...(options?.extraBody ?? {}),
      ...(shouldStream ? { stream: true } : {}),
    };

    if (isToolContinuation && this.lastResponseId) {
      // Continuation mode: send tool results referencing the previous response
      const toolMsgs: Message[] = [];
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.role !== 'tool') break;
        toolMsgs.push(m);
      }
      toolMsgs.reverse();

      body.previous_response_id = this.lastResponseId;
      body.input = toolMsgs.map((m) => ({
        type: 'function_call_output',
        call_id: m.tool_call_id,
        output: m.content ?? '',
      }));
    } else {
      // Non-continuation: convert full history to Responses API input format.
      // Inline tool results as user messages since Responses API doesn't support role=tool in input.
      this.lastResponseId = null;
      body.input = messages
        .filter(m => m.role !== 'tool')
        .map(m => {
          if (m.tool_calls?.length) {
            // Convert assistant tool_call messages to plain text so context isn't lost
            const callSummary = m.tool_calls.map(tc => `Called ${tc.function.name}(${tc.function.arguments})`).join('; ');
            return { role: 'assistant', content: m.content ? `${m.content}\n[${callSummary}]` : `[${callSummary}]` };
          }
          return { role: m.role, content: m.content ?? '' };
        });
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
    const signal = options?.signal
      ? anySignal([options.signal, controller.signal])
      : controller.signal;

    try {
      const response = await fetch(`${this.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal,
      });

      if (!response.ok) {
        const errBody = await response.text();
        throw new Error(`${response.status} ${response.statusText}: ${errBody.slice(0, 500)}`);
      }

      if (shouldStream) {
        return await this.parseResponsesStreamingResponse(response, options?.onDelta);
      } else {
        return await this.parseResponsesNonStreamingResponse(response);
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async parseNonStreamingResponse(response: Response): Promise<ChatResult> {
    const json = await response.json() as any;
    const choice = json.choices?.[0];
    const msg = choice?.message;

    const message: Message = {
      role: 'assistant',
      content: msg?.content ?? null,
      ...(msg?.reasoning_content ? { reasoning_content: msg.reasoning_content } : {}),
      ...(msg?.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}),
    };

    return {
      message,
      usage: {
        inputTokens: json.usage?.prompt_tokens ?? 0,
        outputTokens: json.usage?.completion_tokens ?? 0,
      },
    };
  }

  private async parseStreamingResponse(response: Response, onDelta?: (text: string) => void): Promise<ChatResult> {
    const contentParts: string[] = [];
    const reasoningParts: string[] = [];
    const toolCallAccum = new Map<number, { id: string; name: string; args: string[] }>();
    let usage = { inputTokens: 0, outputTokens: 0 };

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop()!;

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;

        let chunk: any;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }

        const delta = chunk.choices?.[0]?.delta;
        if (delta) {
          // Kimi reasoning_content comes before content
          if (delta.reasoning_content) {
            reasoningParts.push(delta.reasoning_content);
          }

          if (delta.content) {
            contentParts.push(delta.content);
            onDelta?.(delta.content);
          }

          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              if (!toolCallAccum.has(idx)) {
                toolCallAccum.set(idx, { id: tc.id ?? '', name: '', args: [] });
              }
              const accum = toolCallAccum.get(idx)!;
              if (tc.id) accum.id = tc.id;
              if (tc.function?.name) accum.name += tc.function.name;
              if (tc.function?.arguments) accum.args.push(tc.function.arguments);
            }
          }
        }

        if (chunk.usage) {
          usage.inputTokens = chunk.usage.prompt_tokens ?? 0;
          usage.outputTokens = chunk.usage.completion_tokens ?? 0;
        }
      }
    }

    const toolCalls: ToolCall[] = [...toolCallAccum.entries()]
      .sort(([a], [b]) => a - b)
      .map(([_, tc]) => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.name, arguments: tc.args.join('') },
      }));

    const message: Message = {
      role: 'assistant',
      content: contentParts.length > 0 ? contentParts.join('') : null,
      ...(reasoningParts.length > 0 ? { reasoning_content: reasoningParts.join('') } : {}),
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    };

    return { message, usage };
  }

  private getGeminiThinkingConfig(): Record<string, unknown> | null {
    if (this.model.startsWith('gemini-3')) {
      return { thinking_level: 'low' };
    }
    if (this.model.startsWith('gemini-2.5')) {
      return { thinking_budget: 2048 };
    }
    return null;
  }

  private getOpenAIReasoningEffort(): string | null {
    // Only inject for the real OpenAI provider, not other OpenAI-compatible backends.
    if (this.name !== 'openai') return null;
    if (!this.model.startsWith('gpt-5')) return null;
    return 'xhigh';
  }

  // Responses API uses a flat tool schema: {type, name, description, parameters}
  // Chat Completions uses nested: {type, function: {name, description, parameters}}
  // When tool count is large, group into namespaces with tool_search for efficiency.
  private convertToolsForResponses(tools: Array<{ type: string; function: { name: string; description: string; parameters: any } }>): any[] {
    // For small tool sets, use flat format directly
    if (tools.length <= 15) {
      return tools.map(t => ({
        type: 'function',
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters,
      }));
    }

    // Large tool sets: group into namespaces with deferred loading
    // so the model uses tool_search instead of loading 100+ schemas
    const namespaceMap: Record<string, { description: string; tools: string[] }> = {
      marvin_web: {
        description: 'Web search, news, browsing, and scraping tools.',
        tools: ['web_search', 'search_news', 'browse_web', 'scrape_page', 'read_rss'],
      },
      marvin_wiki: {
        description: 'Wikipedia search, summaries, full articles, and grep.',
        tools: ['wiki_search', 'wiki_summary', 'wiki_full', 'wiki_grep'],
      },
      marvin_academic: {
        description: 'Academic paper search on Semantic Scholar and arXiv.',
        tools: ['search_papers', 'search_arxiv'],
      },
      marvin_files: {
        description: 'Read, create, edit, patch, list, grep, and find files in the working directory.',
        tools: ['read_file', 'create_file', 'append_file', 'apply_patch', 'list_files', 'grep_files', 'find_files'],
      },
      marvin_git: {
        description: 'Git operations: status, diff, log, blame, commit, branch, checkout.',
        tools: ['git_status', 'git_diff', 'git_log', 'git_blame', 'git_commit', 'git_branch', 'git_checkout'],
      },
      marvin_github: {
        description: 'GitHub operations: clone repos, read files, grep code.',
        tools: ['github_clone', 'github_read_file', 'github_grep'],
      },
      marvin_notes: {
        description: 'Personal notes: write, read, list, search, organize.',
        tools: ['write_note', 'read_note', 'notes_ls', 'notes_mkdir', 'search_notes'],
      },
      marvin_media: {
        description: 'Search movies (TMDB), games (IGDB/RAWG), and Steam.',
        tools: ['search_movies', 'get_movie_details', 'search_games', 'get_game_details', 'steam_search', 'steam_app_details', 'steam_featured', 'steam_player_stats', 'steam_user_games', 'steam_user_summary'],
      },
      marvin_music: {
        description: 'Music search/lookup (MusicBrainz) and Spotify playback/playlists.',
        tools: ['music_search', 'music_lookup', 'spotify_auth', 'spotify_search', 'spotify_create_playlist', 'spotify_add_tracks', 'spotify_playback', 'spotify_now_playing'],
      },
      marvin_calendar: {
        description: 'Calendar events, alarms, and timers.',
        tools: ['calendar_list_upcoming', 'calendar_add_event', 'calendar_delete_event', 'set_alarm', 'list_alarms', 'cancel_alarm', 'timer_start', 'timer_check', 'timer_stop'],
      },
      marvin_location: {
        description: 'Location, maps (OSM/Overpass), weather, travel directions, and places.',
        tools: ['get_my_location', 'osm_search', 'overpass_query', 'weather_forecast', 'estimate_travel_time', 'get_directions', 'places_text_search', 'places_nearby_search', 'setup_google_auth'],
      },
      marvin_downloads: {
        description: 'Download files and media (including yt-dlp for video/audio).',
        tools: ['download_file', 'yt_dlp_download'],
      },
      marvin_blender: {
        description: 'Blender 3D: scene inspection, object CRUD, materials, code execution, screenshots.',
        tools: ['blender_get_scene', 'blender_get_object', 'blender_create_object', 'blender_modify_object', 'blender_delete_object', 'blender_set_material', 'blender_execute_code', 'blender_screenshot'],
      },
      marvin_utilities: {
        description: 'Unit conversion, dictionary, translation, system info, OCR, transcription, image generation, recipes, ntfy notifications, bookmarks, tickets.',
        tools: ['convert_units', 'dictionary_lookup', 'translate_text', 'system_info', 'ocr', 'transcribe_audio', 'generate_image', 'recipe_search', 'recipe_lookup', 'generate_ntfy_topic', 'ntfy_subscribe', 'ntfy_unsubscribe', 'ntfy_publish', 'ntfy_list', 'bookmark_save', 'bookmark_list', 'bookmark_search', 'tk', 'install_packages'],
      },
    };

    // Always-loaded tools (not deferred) — essential for basic operation
    const alwaysLoaded = new Set([
      'run_command', 'set_working_dir', 'get_working_dir',
      'review_codebase', 'review_status',
      'exit_app', 'get_usage', 'switch_profile', 'update_preferences',
    ]);

    // Build namespace index for quick lookup
    const toolToNamespace = new Map<string, string>();
    for (const [ns, def] of Object.entries(namespaceMap)) {
      for (const name of def.tools) {
        toolToNamespace.set(name, ns);
      }
    }

    // Separate tools into always-loaded and namespaced
    const directTools: any[] = [];
    const namespacedTools = new Map<string, any[]>();

    for (const t of tools) {
      const name = t.function.name;
      const flat = {
        type: 'function',
        name,
        description: t.function.description,
        parameters: t.function.parameters,
      };

      if (alwaysLoaded.has(name)) {
        directTools.push(flat);
      } else {
        const ns = toolToNamespace.get(name);
        if (ns) {
          if (!namespacedTools.has(ns)) namespacedTools.set(ns, []);
          namespacedTools.get(ns)!.push({ ...flat, defer_loading: true });
        } else {
          // Ungrouped tool — load directly
          directTools.push(flat);
        }
      }
    }

    // Build namespace objects
    const namespaces: any[] = [];
    for (const [ns, nsTools] of namespacedTools) {
      const def = namespaceMap[ns];
      if (def && nsTools.length > 0) {
        namespaces.push({
          type: 'namespace',
          name: ns,
          description: def.description,
          tools: nsTools,
        });
      }
    }

    return [
      ...directTools,
      ...namespaces,
      { type: 'tool_search' },
    ];
  }

  private async parseResponsesNonStreamingResponse(response: Response): Promise<ChatResult> {
    const json = await response.json() as any;
    if (json?.id) this.lastResponseId = json.id;

    this.debugLogResponse(json);

    const toolCalls: ToolCall[] = (json?.output ?? [])
      .filter((o: any) => o?.type === 'function_call' && o?.name && o?.call_id
        && o?.status !== 'incomplete' && o?.status !== 'in_progress')
      .map((o: any) => ({
        id: o.call_id,
        type: 'function' as const,
        function: {
          name: o.name,
          arguments: o.arguments ?? '{}',
        },
      }));

    const rawContent = this.extractResponsesOutputText(json);
    const content = this.sanitizeCoT(rawContent);

    const message: Message = {
      role: 'assistant',
      content,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    };

    return {
      message,
      usage: {
        inputTokens: json.usage?.input_tokens ?? 0,
        outputTokens: json.usage?.output_tokens ?? 0,
      },
    };
  }

  private async parseResponsesStreamingResponse(response: Response, onDelta?: (text: string) => void): Promise<ChatResult> {
    const contentParts: string[] = [];
    let usage = { inputTokens: 0, outputTokens: 0 };

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop()!;

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (!data || data === '[DONE]') continue;

        let chunk: any;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }

        // Only capture output_text deltas, skip reasoning deltas
        if (chunk?.type && typeof chunk.type === 'string' && chunk.type === 'response.output_text.delta' && typeof chunk.delta === 'string') {
          contentParts.push(chunk.delta);
          onDelta?.(chunk.delta);
        }

        if (chunk?.response?.id) {
          this.lastResponseId = chunk.response.id;
        }

        const u = chunk?.response?.usage ?? chunk?.usage;
        if (u) {
          usage.inputTokens = u.input_tokens ?? usage.inputTokens;
          usage.outputTokens = u.output_tokens ?? usage.outputTokens;
        }
      }
    }

    const rawContent = contentParts.length > 0 ? contentParts.join('') : null;
    const message: Message = {
      role: 'assistant',
      content: this.sanitizeCoT(rawContent),
    };

    return { message, usage };
  }

  private extractResponsesOutputText(json: any): string | null {
    // Do NOT use json.output_text — it includes reasoning/thinking summaries.
    // Only extract text from explicit 'message' output items.
    const parts: string[] = [];
    for (const item of json?.output ?? []) {
      // Skip reasoning items entirely
      if (item?.type === 'reasoning') continue;

      if (item?.type === 'message') {
        for (const c of item.content ?? []) {
          if (c?.type === 'output_text' && typeof c.text === 'string') {
            parts.push(c.text);
          }
        }
      }
    }

    return parts.length > 0 ? parts.join('') : null;
  }

  destroy(): void {
    // No persistent resources to clean up for HTTP-based provider
  }

  /** Clear continuation state (e.g. after context compaction). */
  resetContinuation(): void {
    this.lastResponseId = null;
  }

  /** Log raw Responses API JSON for debugging reasoning leaks. */
  private debugLogResponse(json: any): void {
    try {
      const logDir = join(homedir(), '.config', 'local-finder');
      mkdirSync(logDir, { recursive: true });
      const entry = {
        ts: new Date().toISOString(),
        model: this.model,
        id: json?.id,
        outputTypes: (json?.output ?? []).map((o: any) => o?.type),
        outputSummary: (json?.output ?? []).map((o: any) => {
          if (o?.type === 'reasoning') return { type: 'reasoning', len: JSON.stringify(o).length };
          if (o?.type === 'message') return { type: 'message', content: (o.content ?? []).map((c: any) => ({ type: c?.type, len: c?.text?.length ?? 0, preview: c?.text?.slice(0, 100) })) };
          if (o?.type === 'function_call') return { type: 'function_call', name: o?.name, call_id: o?.call_id };
          return { type: o?.type };
        }),
      };
      appendFileSync(join(logDir, 'responses-debug.jsonl'), JSON.stringify(entry) + '\n');
    } catch { /* ignore logging errors */ }
  }

  /**
   * Strip chain-of-thought artifacts from response content.
   * gpt-5.4 sometimes leaks internal reasoning into message content:
   * - ChatGPT-style tool calls (to=functions.xxx)
   * - Multilingual reasoning tokens (Chinese, Thai, Armenian, etc.)
   * - Internal deliberation text about tool selection
   */
  private sanitizeCoT(text: string | null): string | null {
    if (!text) return text;
    // Detect ChatGPT internal tool call format leaking through
    if (/to=functions\.\w+/.test(text) || /to=multi_tool_use\./.test(text)) {
      return null;
    }
    return text;
  }
}

// Combine multiple AbortSignals into one
function anySignal(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

/** @deprecated Use OpenAICompatProvider */
export const OpenAIProvider = OpenAICompatProvider;
