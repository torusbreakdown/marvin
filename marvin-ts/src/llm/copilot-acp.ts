/**
 * Copilot ACP mode — spawns a persistent copilot-cli process via the Agent Client Protocol
 * and forwards user prompts to it, streaming responses back.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import type { StreamCallbacks } from '../types.js';

const DEFAULT_MODEL = 'claude-opus-4.6';

export interface CopilotAcpSession {
  /** Send a prompt and stream the response via callbacks. */
  prompt(text: string, callbacks: StreamCallbacks): Promise<void>;
  /** Cancel the current prompt turn. */
  cancel(): void;
  /** Tear down the ACP session and kill the child process. */
  destroy(): void;
  /** Whether the session is connected and ready. */
  readonly ready: boolean;
}

export async function createCopilotAcpSession(opts?: {
  model?: string;
  cwd?: string;
  allowAll?: boolean;
}): Promise<CopilotAcpSession> {
  const model = opts?.model ?? DEFAULT_MODEL;
  const cwd = opts?.cwd ?? process.cwd();

  const executable = process.env.COPILOT_CLI_PATH ?? 'copilot';
  const args = ['--acp', '--stdio', '--model', model];
  if (opts?.allowAll) args.push('--allow-all');

  const proc = spawn(executable, args, {
    stdio: ['pipe', 'pipe', 'inherit'],
  });

  if (!proc.stdin || !proc.stdout) {
    throw new Error('Failed to start copilot ACP process with piped stdio.');
  }

  const output = Writable.toWeb(proc.stdin) as WritableStream<Uint8Array>;
  const input = Readable.toWeb(proc.stdout) as ReadableStream<Uint8Array>;
  const stream = acp.ndJsonStream(output, input);

  // Current prompt's callbacks — set on each prompt() call
  let currentCallbacks: StreamCallbacks | null = null;
  let sessionId: string | null = null;
  let ready = false;
  let destroyed = false;

  const client: acp.Client = {
    async requestPermission(params) {
      // Auto-approve the first "allow" option if available, otherwise cancel
      const allow = params.options.find((o: { kind: string }) => o.kind === 'allow_once' || o.kind === 'allow_always');
      if (allow) {
        return { outcome: { outcome: 'selected', optionId: allow.optionId } };
      }
      return { outcome: { outcome: 'cancelled' } };
    },

    async sessionUpdate(params) {
      const update = params.update;

      if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
        currentCallbacks?.onDelta(update.content.text);
      }

      if (update.sessionUpdate === 'tool_call') {
        const name = update.title ?? update.kind ?? 'tool';
        currentCallbacks?.onToolCallStart([String(name)]);
      }
    },
  };

  const connection = new acp.ClientSideConnection((_agent) => client, stream);

  // Initialize the protocol
  await connection.initialize({
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: {},
  });

  // Create a session
  const sessionResult = await connection.newSession({
    cwd,
    mcpServers: [],
  });
  sessionId = sessionResult.sessionId;
  ready = true;

  return {
    get ready() { return ready && !destroyed; },

    async prompt(text: string, callbacks: StreamCallbacks) {
      if (destroyed) throw new Error('Copilot ACP session is destroyed');
      if (!sessionId) throw new Error('No active ACP session');

      currentCallbacks = callbacks;
      try {
        const result = await connection.prompt({
          sessionId,
          prompt: [{ type: 'text', text }],
        });

        // Build final message from stop reason
        const msg = { role: 'assistant' as const, content: '' };
        callbacks.onComplete(msg);

        if (result.stopReason !== 'end_turn') {
          callbacks.onError(new Error(`Copilot stopped: ${result.stopReason}`));
        }
      } catch (err) {
        callbacks.onError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        currentCallbacks = null;
      }
    },

    cancel() {
      if (sessionId && !destroyed) {
        connection.cancel({ sessionId }).catch(() => {});
      }
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      ready = false;
      try { proc.stdin?.end(); } catch { /* ignore */ }
      try { proc.kill('SIGTERM'); } catch { /* ignore */ }
    },
  };
}
