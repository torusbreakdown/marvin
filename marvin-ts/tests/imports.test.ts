import { describe, it, expect } from 'vitest';

describe('Module imports — all modules export expected symbols', () => {
  it('src/main.ts exports main', async () => {
    const mod = await import('../src/main.js');
    expect(typeof mod.main).toBe('function');
  });

  it('src/session.ts exports SessionManager', async () => {
    const mod = await import('../src/session.js');
    expect(mod.SessionManager).toBeDefined();
    expect(typeof mod.SessionManager).toBe('function');
  });

  it('src/context.ts exports ContextBudgetManager, estimateTokens, compactContext', async () => {
    const mod = await import('../src/context.js');
    expect(mod.ContextBudgetManager).toBeDefined();
    expect(typeof mod.ContextBudgetManager).toBe('function');
    expect(typeof mod.estimateTokens).toBe('function');
    expect(typeof mod.compactContext).toBe('function');
  });

  it('src/history.ts exports loadChatLog, saveChatLog, appendChatLog, compactHistory, searchHistoryBackups', async () => {
    const mod = await import('../src/history.js');
    expect(typeof mod.loadChatLog).toBe('function');
    expect(typeof mod.saveChatLog).toBe('function');
    expect(typeof mod.appendChatLog).toBe('function');
    expect(typeof mod.compactHistory).toBe('function');
    expect(typeof mod.searchHistoryBackups).toBe('function');
  });

  it('src/usage.ts exports UsageTracker', async () => {
    const mod = await import('../src/usage.js');
    expect(mod.UsageTracker).toBeDefined();
    expect(typeof mod.UsageTracker).toBe('function');
  });

  it('src/system-prompt.ts exports buildSystemMessage and seedHistoryMessages', async () => {
    const mod = await import('../src/system-prompt.js');
    expect(typeof mod.buildSystemMessage).toBe('function');
    expect(typeof mod.seedHistoryMessages).toBe('function');
  });

  it('src/llm/router.ts exports runToolLoop', async () => {
    const mod = await import('../src/llm/router.js');
    expect(typeof mod.runToolLoop).toBe('function');
  });

  it('src/llm/openai.ts exports OpenAICompatProvider', async () => {
    const mod = await import('../src/llm/openai.js');
    expect(mod.OpenAICompatProvider).toBeDefined();
    expect(typeof mod.OpenAICompatProvider).toBe('function');
  });

  it('src/llm/copilot.ts exports CopilotProvider', async () => {
    const mod = await import('../src/llm/copilot.js');
    expect(mod.CopilotProvider).toBeDefined();
    expect(typeof mod.CopilotProvider).toBe('function');
  });

  it('src/llm/ollama.ts exports OllamaProvider', async () => {
    const mod = await import('../src/llm/ollama.js');
    expect(mod.OllamaProvider).toBeDefined();
    expect(typeof mod.OllamaProvider).toBe('function');
  });

  it('src/tools/registry.ts exports ToolRegistry', async () => {
    const mod = await import('../src/tools/registry.js');
    expect(mod.ToolRegistry).toBeDefined();
    expect(typeof mod.ToolRegistry).toBe('function');
  });

  it('src/tools/location.ts exports registerLocationTools', async () => {
    const mod = await import('../src/tools/location.js');
    expect(typeof mod.registerLocationTools).toBe('function');
  });

  it('src/tools/places.ts exports registerPlacesTools', async () => {
    const mod = await import('../src/tools/places.js');
    expect(typeof mod.registerPlacesTools).toBe('function');
  });

  it('src/tools/travel.ts exports registerTravelTools', async () => {
    const mod = await import('../src/tools/travel.js');
    expect(typeof mod.registerTravelTools).toBe('function');
  });

  it('src/tools/weather.ts exports registerWeatherTools', async () => {
    const mod = await import('../src/tools/weather.js');
    expect(typeof mod.registerWeatherTools).toBe('function');
  });

  it('src/tools/web.ts exports registerWebTools', async () => {
    const mod = await import('../src/tools/web.js');
    expect(typeof mod.registerWebTools).toBe('function');
  });

  it('src/tools/media.ts exports registerMediaTools', async () => {
    const mod = await import('../src/tools/media.js');
    expect(typeof mod.registerMediaTools).toBe('function');
  });

  it('src/tools/steam.ts exports registerSteamTools', async () => {
    const mod = await import('../src/tools/steam.js');
    expect(typeof mod.registerSteamTools).toBe('function');
  });

  it('src/tools/music.ts exports registerMusicTools', async () => {
    const mod = await import('../src/tools/music.js');
    expect(typeof mod.registerMusicTools).toBe('function');
  });

  it('src/tools/recipes.ts exports registerRecipesTools', async () => {
    const mod = await import('../src/tools/recipes.js');
    expect(typeof mod.registerRecipesTools).toBe('function');
  });

  it('src/tools/notes.ts exports registerNotesTools', async () => {
    const mod = await import('../src/tools/notes.js');
    expect(typeof mod.registerNotesTools).toBe('function');
  });

  it('src/tools/files.ts exports registerFilesTools', async () => {
    const mod = await import('../src/tools/files.js');
    expect(typeof mod.registerFilesTools).toBe('function');
  });

  it('src/tools/files-notes.ts exports registerFilesNotesTools', async () => {
    const mod = await import('../src/tools/files-notes.js');
    expect(typeof mod.registerFilesNotesTools).toBe('function');
  });

  it('src/tools/coding.ts exports registerCodingTools', async () => {
    const mod = await import('../src/tools/coding.js');
    expect(typeof mod.registerCodingTools).toBe('function');
  });

  it('src/tools/git.ts exports registerGitTools', async () => {
    const mod = await import('../src/tools/git.js');
    expect(typeof mod.registerGitTools).toBe('function');
  });

  it('src/tools/shell.ts exports registerShellTools', async () => {
    const mod = await import('../src/tools/shell.js');
    expect(typeof mod.registerShellTools).toBe('function');
  });

  it('src/tools/github.ts exports registerGithubTools', async () => {
    const mod = await import('../src/tools/github.js');
    expect(typeof mod.registerGithubTools).toBe('function');
  });

  it('src/tools/calendar.ts exports registerCalendarTools', async () => {
    const mod = await import('../src/tools/calendar.js');
    expect(typeof mod.registerCalendarTools).toBe('function');
  });

  it('src/tools/wiki.ts exports registerWikiTools', async () => {
    const mod = await import('../src/tools/wiki.js');
    expect(typeof mod.registerWikiTools).toBe('function');
  });

  it('src/tools/academic.ts exports registerAcademicTools', async () => {
    const mod = await import('../src/tools/academic.js');
    expect(typeof mod.registerAcademicTools).toBe('function');
  });

  it('src/tools/system.ts exports registerSystemTools', async () => {
    const mod = await import('../src/tools/system.js');
    expect(typeof mod.registerSystemTools).toBe('function');
  });

  it('src/tools/alarms.ts exports registerAlarmsTools', async () => {
    const mod = await import('../src/tools/alarms.js');
    expect(typeof mod.registerAlarmsTools).toBe('function');
  });

  it('src/tools/timers.ts exports registerTimersTools', async () => {
    const mod = await import('../src/tools/timers.js');
    expect(typeof mod.registerTimersTools).toBe('function');
  });

  it('src/tools/ntfy.ts exports registerNtfyTools and pollSubscriptions', async () => {
    const mod = await import('../src/tools/ntfy.js');
    expect(typeof mod.registerNtfyTools).toBe('function');
    expect(typeof mod.pollSubscriptions).toBe('function');
  });

  it('src/tools/spotify.ts exports registerSpotifyTools', async () => {
    const mod = await import('../src/tools/spotify.js');
    expect(typeof mod.registerSpotifyTools).toBe('function');
  });

  it('src/tools/maps.ts exports registerMapsTools', async () => {
    const mod = await import('../src/tools/maps.js');
    expect(typeof mod.registerMapsTools).toBe('function');
  });

  it('src/tools/stack.ts exports registerStackTools', async () => {
    const mod = await import('../src/tools/stack.js');
    expect(typeof mod.registerStackTools).toBe('function');
  });

  it('src/tools/tickets.ts exports registerTicketsTools', async () => {
    const mod = await import('../src/tools/tickets.js');
    expect(typeof mod.registerTicketsTools).toBe('function');
  });

  it('src/tools/bookmarks.ts exports registerBookmarksTools', async () => {
    const mod = await import('../src/tools/bookmarks.js');
    expect(typeof mod.registerBookmarksTools).toBe('function');
  });

  it('src/tools/downloads.ts exports registerDownloadsTools', async () => {
    const mod = await import('../src/tools/downloads.js');
    expect(typeof mod.registerDownloadsTools).toBe('function');
  });

  it('src/tools/utilities.ts exports registerUtilitiesTools', async () => {
    const mod = await import('../src/tools/utilities.js');
    expect(typeof mod.registerUtilitiesTools).toBe('function');
  });

  it('src/ui/curses.ts exports CursesUI', async () => {
    const mod = await import('../src/ui/curses.js');
    expect(mod.CursesUI).toBeDefined();
    expect(typeof mod.CursesUI).toBe('function');
  });

  it('src/ui/plain.ts exports PlainUI', async () => {
    const mod = await import('../src/ui/plain.js');
    expect(mod.PlainUI).toBeDefined();
    expect(typeof mod.PlainUI).toBe('function');
  });

  it('src/ui/shared.ts exports UI interface (type-only), formatMessage, formatToolCall', async () => {
    const mod = await import('../src/ui/shared.js');
    expect(mod).toBeDefined();
    expect(typeof mod.formatMessage).toBe('function');
    expect(typeof mod.formatToolCall).toBe('function');
  });

  it('src/profiles/manager.ts exports ProfileManager, loadOrCreateProfile, loadProfile, saveProfile, switchProfile, listProfiles', async () => {
    const mod = await import('../src/profiles/manager.js');
    expect(mod.ProfileManager).toBeDefined();
    expect(typeof mod.ProfileManager).toBe('function');
    expect(typeof mod.loadOrCreateProfile).toBe('function');
    expect(typeof mod.loadProfile).toBe('function');
    expect(typeof mod.saveProfile).toBe('function');
    expect(typeof mod.switchProfile).toBe('function');
    expect(typeof mod.listProfiles).toBe('function');
  });

  it('src/profiles/prefs.ts exports loadPreferences, savePreferences, updatePreference', async () => {
    const mod = await import('../src/profiles/prefs.js');
    expect(typeof mod.loadPreferences).toBe('function');
    expect(typeof mod.savePreferences).toBe('function');
    expect(typeof mod.updatePreference).toBe('function');
  });

  it('src/tools/register-all.ts exports registerAllTools', async () => {
    const mod = await import('../src/tools/register-all.js');
    expect(typeof mod.registerAllTools).toBe('function');
  });

  it('src/main.ts exports createSession-related helpers (resolveProviderConfig, etc.)', async () => {
    const mod = await import('../src/main.js');
    expect(typeof mod.main).toBe('function');
    expect(typeof mod.parseCliArgs).toBe('function');
    expect(typeof mod.handleSlashCommand).toBe('function');
  });
});
