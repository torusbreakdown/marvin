import type { ToolRegistry } from './registry.js';
import type { SessionUsage } from '../types.js';

import { registerAcademicTools } from './academic.js';
import { registerAlarmsTools } from './alarms.js';
import { registerBlenderTools } from './blender.js';
import { registerBookmarksTools } from './bookmarks.js';
import { registerCalendarTools } from './calendar.js';
import { registerCodingTools } from './coding.js';
import { registerDownloadsTools } from './downloads.js';
import { registerFilesNotesTools } from './files-notes.js';
import { registerFilesTools } from './files.js';
import { registerGitTools } from './git.js';
import { registerGithubTools } from './github.js';
import { registerLocationTools } from './location.js';
import { registerMapsTools } from './maps.js';
import { registerMediaTools } from './media.js';
import { registerMusicTools } from './music.js';
import { registerNotesTools } from './notes.js';
import { registerNtfyTools } from './ntfy.js';
import { registerPackagesTools } from './packages.js';
import { registerPlacesTools } from './places.js';
import { registerRecipesTools } from './recipes.js';
import { registerShellTools } from './shell.js';
import { registerSpotifyTools } from './spotify.js';
import { registerStackTools } from './stack.js';
import { registerSteamTools } from './steam.js';
import { registerSystemTools } from './system.js';
import { registerTicketsTools } from './tickets.js';
import { registerTimersTools } from './timers.js';
import { registerTravelTools } from './travel.js';
import { registerUtilitiesTools } from './utilities.js';
import { registerWeatherTools } from './weather.js';
import { registerWebTools } from './web.js';
import { registerWikiTools } from './wiki.js';

export interface RegisterAllToolsOptions {
  getUsage: () => SessionUsage;
  onExit?: (message: string) => void;
}

export function registerAllTools(registry: ToolRegistry, options: RegisterAllToolsOptions): void {
  registerAcademicTools(registry);
  registerAlarmsTools(registry);
  registerBlenderTools(registry);
  registerBookmarksTools(registry);
  registerCalendarTools(registry);
  registerCodingTools(registry);
  registerDownloadsTools(registry);
  registerFilesNotesTools(registry);
  registerFilesTools(registry);
  registerGitTools(registry);
  registerGithubTools(registry);
  registerLocationTools(registry);
  registerMapsTools(registry);
  registerMediaTools(registry);
  registerMusicTools(registry);
  registerNotesTools(registry);
  registerNtfyTools(registry);
  registerPackagesTools(registry);
  registerPlacesTools(registry);
  registerRecipesTools(registry);
  registerShellTools(registry);
  registerSpotifyTools(registry);
  registerStackTools(registry);
  registerSteamTools(registry);
  registerSystemTools(registry, options);
  registerTicketsTools(registry);
  registerTimersTools(registry);
  registerTravelTools(registry);
  registerUtilitiesTools(registry);
  registerWeatherTools(registry);
  registerWebTools(registry);
  registerWikiTools(registry);
}
