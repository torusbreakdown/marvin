export function loadPreferences(profileDir: string): Record<string, unknown> {
  // Load preferences from prefs.yaml
  return {};
}

export function savePreferences(profileDir: string, prefs: Record<string, unknown>): void {
  // Save full preferences to prefs.yaml
}

export function updatePreference(profileDir: string, key: string, value: unknown): void {
  // Update a single preference key in prefs.yaml
}

/** @deprecated Use loadPreferences instead */
export const loadPrefs = loadPreferences;

/** @deprecated Use updatePreference instead */
export function updatePrefs(profileDir: string, prefs: Record<string, unknown>): void {
  savePreferences(profileDir, prefs);
}
