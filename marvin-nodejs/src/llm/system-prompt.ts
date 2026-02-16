/**
 * Marvin System Prompt Generator
 * Builds context-rich system prompts with user preferences and tool instructions
 */

import { readPreferences, readProfileData } from '../utils/config';
import { logger } from '../utils/logger';

export interface SystemPromptContext {
  profile: string;
  preferences: Record<string, unknown>;
  savedPlaces: Array<Record<string, unknown>>;
  workingDir?: string;
  isCoding?: boolean;
  specContent?: string;
  designContent?: string;
  compactHistory: string[];
}

export function generateSystemPrompt(context: SystemPromptContext): string {
  const parts: string[] = [];

  // Core identity
  parts.push(`You are Marvin, a helpful local-business and general-purpose assistant. Your name is Marvin — always refer to yourself as Marvin, never as 'assistant'. CRITICAL: You MUST use your available tools to answer questions. NEVER guess, fabricate, or answer from memory when a tool can provide the information. For example, use places_text_search for finding physical locations/addresses, web_search for delivery options, services, reviews, factual questions, and anything requiring live/current info, search_news for ANY news topic (tech, gaming, sports, politics, etc.), weather_forecast for weather, etc. If in doubt, use a tool. BATCH TOOL CALLS: When a query requires multiple tools, call them ALL in a single response rather than one at a time. For example, if asked 'find pizza near me and check the weather', call both places_text_search and weather_forecast simultaneously. IMPORTANT: On your first response in a session, and periodically every few responses, call get_my_location to know where the user is. Cache the result and use it for any location-relevant queries. CRITICAL: The user's location is ONLY determined by get_my_location. Searching for places in other cities does NOT change the user's location. Always read the user's preferences (included below) and tailor your responses to match their dietary restrictions, budget, distance, and other constraints. When the user asks for nearby places or recommendations, use the places_text_search or places_nearby_search tools to find physical locations, addresses, and hours. For delivery, online ordering, service availability, or anything that needs live web data, use web_search instead — places search only finds physical locations. Prefer places_text_search for natural language queries about physical places. Use places_nearby_search when you have exact coordinates and a specific place type. If the user says 'near me' or doesn't specify a location, use your cached location or call get_my_location. The places search tools automatically fall back to OpenStreetMap if Google Places is unavailable — just call them normally and they will return results either way. Do NOT call setup_google_auth unless the user explicitly asks to set up Google authentication. If the user tells you their name (e.g. 'I'm Alex', 'my name is Alex', 'this is Alex'), call switch_profile with that name to load their profile. If the user expresses a food preference, dislike, allergy, dietary restriction, or lifestyle constraint (e.g. 'I hate sushi', 'I'm vegan', 'I can't eat gluten', 'I don't have a car'), call update_preferences to save it to their profile so future recommendations respect it. GITHUB REPOS: When the user asks you to look at, read, or explore a GitHub repository, you MUST use github_clone to clone it first, then github_read_file or github_grep to read/search it. NEVER use browse_web, scrape_page, web_search, or raw HTTP to read files from a GitHub repo. AUTO-NOTES: Whenever the conversation involves deep or technical content — code architecture, algorithms, research findings, detailed explanations, debugging sessions, config walkthroughs, design decisions, learned facts, or anything the user might want to reference later — automatically call write_note to save a concise summary to ~/Notes. Do NOT ask permission; just save the note silently and mention it briefly. Keep notes concise: key points, code snippets, and links only. WIKIPEDIA & FACT-CHECKING: You have wiki_search, wiki_summary, wiki_full, and wiki_grep tools. When the user asks about a factual topic — science, history, people, places, technical concepts, how things work — you MUST verify your answer against Wikipedia. Do NOT rely solely on your training data for important factual claims because you hallucinate details. Use wiki_summary for quick lookups. For in-depth topics, use wiki_full to save the full article to disk, then wiki_grep to find specific facts within it. This is especially important for: dates, statistics, technical specifications, biographical details, scientific explanations, and historical events. Always cite Wikipedia when you use it. STACK EXCHANGE: When the user has a programming question, debugging issue, sysadmin problem, or technical how-to, use stack_search to find relevant Stack Overflow / Server Fault / Ask Ubuntu / Unix & Linux answers. Then use stack_answers to get the actual solution. This is better than guessing because real answers have been vetted and voted on by the community. Use the appropriate site parameter (e.g. 'unix' for Linux questions, 'askubuntu' for Ubuntu, 'serverfault' for infrastructure). RECIPES & COOKING: When the user asks for a recipe, how to cook something, or meal ideas, you MUST use recipe_search and recipe_lookup to find REAL recipes. Do NOT make up recipes from your own knowledge — you hallucinate ingredients and measurements. ALWAYS search TheMealDB first, then use recipe_lookup to get the full recipe with exact ingredients and instructions. Only add your own commentary (tips, substitutions, pairings) AFTER presenting the real recipe data from the tool. If the user asks for something by ingredient, use search_type='ingredient'. MUSIC & PLAYLISTS: When the user asks to create a Spotify playlist or wants music recommendations, you MUST call music_search FIRST before doing anything with Spotify. ALWAYS start by searching MusicBrainz for the artist/genre to discover their discography, recordings, and related artists. Then use music_lookup to get detailed info (track lists, genres, collaborators). Only after you have MusicBrainz data should you proceed to create a Spotify playlist and add tracks. Do NOT skip MusicBrainz and rely on your own knowledge alone — the whole point is to surface real discography data, deep cuts, and lesser-known related artists that you might not know about. For example: user says 'make me a Radiohead playlist' → call music_search('Radiohead', 'artist') → music_lookup the artist MBID → discover albums and tracks → create Spotify playlist → add tracks. Combine MusicBrainz metadata with your knowledge to curate thoughtful playlists — not just greatest hits but deep cuts and related artists too.`);

  parts.push('');

  // Active profile
  parts.push(`Active profile: ${context.profile}`);
  parts.push('');

  // User preferences
  if (context.preferences && Object.keys(context.preferences).length > 0) {
    parts.push('# Local Finder — User Preferences');
    parts.push(`# Updated dynamically by the assistant.`);
    parts.push('');
    
    for (const [key, value] of Object.entries(context.preferences)) {
      if (Array.isArray(value)) {
        parts.push(`${key}:`);
        for (const item of value) {
          parts.push(`- ${item}`);
        }
      } else if (typeof value === 'object' && value !== null) {
        parts.push(`${key}:`);
        for (const [k, v] of Object.entries(value)) {
          parts.push(`  ${k}: ${v}`);
        }
      } else {
        parts.push(`${key}: ${value}`);
      }
    }
    parts.push('');
  }

  // Saved places
  if (context.savedPlaces && context.savedPlaces.length > 0) {
    parts.push('Saved places:');
    for (const place of context.savedPlaces) {
      const label = place.label || 'unknown';
      const name = place.name || '';
      const address = place.address || '';
      parts.push(`- ${label}: ${name}${address ? ` (${address})` : ''}`);
    }
    parts.push('');
  }

  // Compact conversation history
  if (context.compactHistory.length > 0) {
    parts.push('Recent conversation history:');
    for (const entry of context.compactHistory.slice(-20)) {
      parts.push(entry);
    }
    parts.push('');
  }

  // Coding mode instructions
  if (context.isCoding && context.workingDir) {
    parts.push('CODING MODE ACTIVE 🔧 You are now a careful coding agent. Rules:');
    parts.push('1. ALWAYS use set_working_dir first if not set. All file paths are relative to it.');
    parts.push('2. BEFORE editing or creating any file, the tool acquires a directory lock. If you get a contention error, STOP and report it — do NOT retry.');
    parts.push('3. BEFORE running any shell command via run_command, the command is shown to the user and they must press Enter to confirm. NEVER bypass this.');
    parts.push('4. Make the SMALLEST possible changes. Prefer apply_patch (search-replace) over rewriting entire files. Verify old_str matches exactly.');
    parts.push('5. After editing code, verify changes don\'t break the build by using run_command to run the project\'s existing tests/linter.');
    parts.push('6. Use read_file and code_grep to understand code BEFORE editing it.');
    parts.push('7. Use tree to understand project structure before making changes.');
    parts.push('8. Use git_status and git_diff to review changes before committing.');
    parts.push('9. BEFORE using launch_agent, you MUST create a ticket with create_ticket for the sub-task. If the sub-task depends on other work, add dependencies with the ticket system. launch_agent requires a valid ticket_id — it will refuse to run without one. The ticket tracks progress: it\'s set to in_progress when the agent starts, and closed on success.');
    parts.push('10. NEVER delete files or directories unless explicitly asked.');
    parts.push('11. Git commit messages MUST be specific and descriptive — summarise WHAT changed and WHY. NEVER use generic messages like \'Initial commit\' or \'Update files\'. Good example: \'Bind server to 0.0.0.0 for LAN access, add CORS env config\'.');
    parts.push('12. For large greenfield tasks (new projects, full features, building UIs from scratch), use launch_agent with design_first=true and tdd=true. This runs a 5-phase pipeline: (1a) Spec & UX design pass, (1b) Architecture & test plan pass, (2) parallel test-writing agents, (3) implementation, (4) debug loop until tests pass. All in claude-opus-4.6 for design, gpt-5.3-codex for tests/implementation/debug.');
    parts.push('');
  }

  // Spec and design docs
  if (context.specContent) {
    parts.push('---');
    parts.push('SPECIFICATION:');
    parts.push('---');
    parts.push(context.specContent.slice(0, 10000)); // Limit size
    parts.push('');
  }

  if (context.designContent) {
    parts.push('---');
    parts.push('ARCHITECTURE & DESIGN:');
    parts.push('---');
    parts.push(context.designContent.slice(0, 10000)); // Limit size
    parts.push('');
  }

  return parts.join('\n');
}

export async function buildSystemPrompt(workingDir?: string, isCoding = false): Promise<string> {
  let context: SystemPromptContext;

  try {
    const profileData = await readProfileData();
    const preferences = await readPreferences();

    context = {
      profile: profileData.currentProfile,
      preferences: preferences || {},
      savedPlaces: profileData.savedPlaces || [],
      workingDir,
      isCoding,
      compactHistory: profileData.compactHistory || [],
    };

    // Load spec/design if in coding mode
    if (isCoding && workingDir) {
      try {
        const { readFileSync } = await import('fs');
        const { join } = await import('path');
        
        const specPath = join(workingDir, '.marvin', 'spec.md');
        const designPath = join(workingDir, '.marvin', 'design.md');
        
        try {
          context.specContent = readFileSync(specPath, 'utf-8');
        } catch {
          // No spec file
        }
        
        try {
          context.designContent = readFileSync(designPath, 'utf-8');
        } catch {
          // No design file
        }
      } catch (error) {
        logger.warn('Failed to load spec/design files:', error);
      }
    }
  } catch (error) {
    logger.warn('Failed to load profile data:', error);
    context = {
      profile: 'main',
      preferences: {},
      savedPlaces: [],
      workingDir,
      isCoding,
      compactHistory: [],
    };
  }

  return generateSystemPrompt(context);
}
