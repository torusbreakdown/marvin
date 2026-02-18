import type { Message, ChatLogEntry, MessageRole, UserProfile } from './types.js';

export interface BuildSystemMessageOptions {
  codingMode?: boolean;
  backgroundJobs?: Array<{ id: string; status: string; description: string }>;
}

export function buildSystemMessage(
  profile: UserProfile,
  options: BuildSystemMessageOptions = {},
): string {
  const parts: string[] = [];

  // 1. Personality
  parts.push(
    'You are Marvin, a helpful local CLI assistant. You have access to many tools ' +
    'for web search, location, weather, files, coding, and more. Be concise and helpful.'
  );

  // 2. Active profile
  parts.push(`\nActive profile: ${profile.name}`);

  // 3. User preferences
  const prefs = profile.preferences;
  if (prefs && Object.keys(prefs).length > 0) {
    parts.push('\nUser preferences:');
    if (prefs.dietary && Array.isArray(prefs.dietary)) {
      parts.push(`  Dietary: ${prefs.dietary.join(', ')}`);
    }
    if (prefs.budget) parts.push(`  Budget: ${prefs.budget}`);
    if (prefs.distance_unit) parts.push(`  Distance unit: ${prefs.distance_unit}`);
    if (prefs.cuisines && Array.isArray(prefs.cuisines)) {
      parts.push(`  Cuisines: ${prefs.cuisines.join(', ')}`);
    }
    // Include any other custom preferences
    for (const [key, val] of Object.entries(prefs)) {
      if (!['dietary', 'budget', 'distance_unit', 'cuisines'].includes(key) && val != null) {
        parts.push(`  ${key}: ${typeof val === 'object' ? JSON.stringify(val) : String(val)}`);
      }
    }
  }

  // 4. Saved places
  if (profile.savedPlaces.length > 0) {
    parts.push('\nSaved places:');
    for (const place of profile.savedPlaces) {
      parts.push(`  ${place.label}: ${place.name}, ${place.address} (${place.lat}, ${place.lng})`);
    }
  }

  // 5. Coding mode
  if (options.codingMode) {
    parts.push(
      '\nCoding mode is active. You have access to file operations, git, shell commands, ' +
      'and coding tools. Use apply_patch for edits. For large files, use create_file then ' +
      'append_file. Always check working directory before file operations.'
    );
  }

  // 6. Compact history (last 20 entries, 200 chars each)
  if (profile.chatLog.length > 0) {
    const compact = compactHistoryString(profile.chatLog, 20);
    if (compact) parts.push(compact);
  }

  // 7. Background jobs
  if (options.backgroundJobs && options.backgroundJobs.length > 0) {
    parts.push('\nBackground jobs:');
    for (const job of options.backgroundJobs) {
      parts.push(`  ${job.id}: ${job.status} — ${job.description}`);
    }
  }

  return parts.join('\n');
}

function compactHistoryString(chatLog: ChatLogEntry[], limit: number = 20): string {
  const recent = chatLog.slice(-limit);
  if (recent.length === 0) return '';
  const lines = recent.map(e => {
    const prefix = e.role === 'you' ? 'User' : e.role === 'assistant' ? 'Asst' : 'Sys';
    const truncated = e.text.length > 200 ? e.text.slice(0, 200) + '...' : e.text;
    return `${prefix}: ${truncated}`;
  });
  return `\nRecent conversation:\n${lines.join('\n')}`;
}

export function seedHistoryMessages(chatLog: ChatLogEntry[], limit: number = 20): Message[] {
  const recent = chatLog.slice(-limit);
  return recent
    .filter(entry => entry.role !== 'system')
    .map(entry => ({
      role: (entry.role === 'you' ? 'user' : entry.role) as MessageRole,
      content: entry.text,
    }));
}
