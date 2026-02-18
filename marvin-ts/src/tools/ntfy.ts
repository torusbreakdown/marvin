import { z } from 'zod';
import type { ToolRegistry } from './registry.js';
import type { ToolContext, UserProfile } from '../types.js';

const WORD_LIST = [
  'apple', 'banana', 'cherry', 'delta', 'eagle', 'falcon', 'grape', 'harbor',
  'ivory', 'jungle', 'kettle', 'lemon', 'mango', 'nebula', 'orbit', 'planet',
  'quartz', 'river', 'solar', 'tiger', 'ultra', 'violet', 'walrus', 'xenon',
  'yellow', 'zebra', 'anchor', 'bridge', 'castle', 'dragon', 'ember', 'forest',
  'glacier', 'horizon', 'island', 'jasper', 'koala', 'lantern', 'marble', 'nectar',
  'ocean', 'parrot', 'quest', 'raven', 'summit', 'thunder', 'umber', 'vivid',
  'willow', 'zephyr', 'atlas', 'blaze', 'coral', 'drift', 'echo', 'flame',
];

function generateTopicName(): string {
  const words: string[] = [];
  for (let i = 0; i < 5; i++) {
    words.push(WORD_LIST[Math.floor(Math.random() * WORD_LIST.length)]);
  }
  return words.join('-');
}

export function registerNtfyTools(registry: ToolRegistry): void {
  registry.registerTool(
    'generate_ntfy_topic',
    'Generate a unique ntfy.sh notification topic URL',
    z.object({
      label: z.string().default('').describe('Optional friendly label'),
    }),
    async (args, ctx) => {
      const topic = generateTopicName();
      const url = `https://ntfy.sh/${topic}`;
      return `Generated ntfy topic: ${topic}\nURL: ${url}${args.label ? `\nLabel: ${args.label}` : ''}`;
    },
    'always',
  );

  registry.registerTool(
    'ntfy_subscribe',
    'Subscribe to an existing ntfy.sh topic',
    z.object({
      topic: z.string().describe('Topic name to subscribe to'),
      label: z.string().default('').describe('Friendly label'),
    }),
    async (args, ctx) => {
      // SECURITY: In interactive mode, subscribing requires user confirmation.
      // Without this, a prompt-injected LLM could subscribe to an attacker-controlled
      // topic and then publish sensitive data to it (subscribe + publish = exfiltration).
      if (!ctx.nonInteractive && ctx.confirmCommand) {
        const confirmed = await ctx.confirmCommand(`Subscribe to ntfy topic: ${args.topic}`);
        if (!confirmed) {
          return 'Subscription declined by user.';
        }
      }
      const existing = ctx.profile.ntfySubscriptions.find(s => s.topic === args.topic);
      if (!existing) {
        ctx.profile.ntfySubscriptions.push({ topic: args.topic });
      }
      return `Subscribed to ntfy topic: ${args.topic}`;
    },
    'always',
  );

  registry.registerTool(
    'ntfy_unsubscribe',
    'Unsubscribe from a ntfy.sh topic',
    z.object({
      topic: z.string().describe('Topic name to unsubscribe from'),
    }),
    async (args, ctx) => {
      const idx = ctx.profile.ntfySubscriptions.findIndex(s => s.topic === args.topic);
      if (idx === -1) return `Error: Not subscribed to topic: ${args.topic}`;
      ctx.profile.ntfySubscriptions.splice(idx, 1);
      return `Unsubscribed from ntfy topic: ${args.topic}`;
    },
    'always',
  );

  registry.registerTool(
    'ntfy_publish',
    'Send a push notification to a ntfy.sh topic',
    z.object({
      topic: z.string().describe('Topic to publish to'),
      message: z.string().describe('Notification message'),
      title: z.string().default('').describe('Optional title'),
    }),
    async (args, _ctx) => {
      // SECURITY: Only allow publishing to topics the user has explicitly subscribed to.
      // Without this restriction, a prompt-injected LLM could exfiltrate sensitive data
      // (file contents, env vars, etc.) by publishing to an attacker-controlled topic.
      const isSubscribed = _ctx.profile.ntfySubscriptions.some(s => s.topic === args.topic);
      if (!isSubscribed) {
        return `Error: Cannot publish to unsubscribed topic "${args.topic}". Subscribe first with ntfy_subscribe.`;
      }
      const headers: Record<string, string> = {};
      if (args.title) headers['Title'] = args.title;
      const resp = await fetch(`https://ntfy.sh/${args.topic}`, {
        method: 'POST',
        body: args.message,
        headers,
      });
      if (!resp.ok) return `Error: Failed to send notification (${resp.status})`;
      return `Sent notification to ${args.topic}: ${args.message}`;
    },
    'always',
  );

  registry.registerTool(
    'ntfy_list',
    'List all active ntfy.sh subscriptions',
    z.object({}),
    async (_args, ctx) => {
      const subs = ctx.profile.ntfySubscriptions;
      if (subs.length === 0) return 'No active ntfy subscriptions.';
      return subs
        .map((s, i) => `${i + 1}. ${s.topic} — https://ntfy.sh/${s.topic}`)
        .join('\n');
    },
    'always',
  );
}

export async function pollSubscriptions(profile: UserProfile, signal?: AbortSignal): Promise<string[]> {
  if (profile.ntfySubscriptions.length === 0) return [];

  const messages: string[] = [];
  for (const sub of profile.ntfySubscriptions) {
    try {
      const since = sub.lastMessageId ?? 'all';
      const url = `https://ntfy.sh/${sub.topic}/json?poll=1&since=${since}`;
      const resp = await fetch(url, { signal });
      if (!resp.ok) continue;
      const text = await resp.text();
      const lines = text.trim().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const msg = JSON.parse(line);
          if (msg.event === 'message') {
            messages.push(`[${sub.topic}] ${msg.title ? msg.title + ': ' : ''}${msg.message}`);
            sub.lastMessageId = msg.id;
          }
        } catch { /* skip malformed */ }
      }
    } catch { /* network error, skip */ }
  }
  return messages;
}
