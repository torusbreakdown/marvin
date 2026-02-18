import type { ToolRegistry } from './registry.js';
import type { UserProfile } from '../types.js';

export function registerNtfyTools(registry: ToolRegistry): void {
  // generate_ntfy_topic, ntfy_subscribe/unsubscribe/publish/list + polling logic
}

export async function pollSubscriptions(profile: UserProfile, signal?: AbortSignal): Promise<string[]> {
  // Poll ntfy.sh for new notifications on subscribed topics
  return [];
}
