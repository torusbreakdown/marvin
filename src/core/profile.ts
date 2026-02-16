import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";

export interface Preferences {
  dietary?: string[];
  spice_tolerance?: string;
  favorite_cuisines?: string[];
  avoid_cuisines?: string[];
  budget?: string;
  max_distance_km?: number;
  transport?: string;
  notes?: string;
  [k: string]: unknown;
}

export interface ProfileData {
  activeProfile: string;
  preferences: Preferences;
  savedPlacesRaw: unknown;
  compactHistory: string;
}

function configBaseDir() {
  return path.join(os.homedir(), ".config", "local-finder");
}

export async function readProfileData(): Promise<ProfileData> {
  const base = configBaseDir();
  const lastProfilePath = path.join(base, "last_profile");

  let activeProfile = "main";
  try {
    activeProfile = (await fs.readFile(lastProfilePath, "utf8")).trim() || "main";
  } catch {
    // ignore
  }

  const profileDir = path.join(base, "profiles", activeProfile);

  let preferences: Preferences = {};
  try {
    const prefText = await fs.readFile(path.join(profileDir, "preferences.yaml"), "utf8");
    preferences = (YAML.parse(prefText) ?? {}) as Preferences;
  } catch {
    // ignore
  }

  let savedPlacesRaw: unknown = [];
  try {
    savedPlacesRaw = JSON.parse(
      await fs.readFile(path.join(profileDir, "saved_places.json"), "utf8"),
    );
  } catch {
    // ignore
  }

  let compactHistory = "";
  try {
    const log = JSON.parse(await fs.readFile(path.join(profileDir, "chat_log.json"), "utf8"));
    if (Array.isArray(log)) {
      const last = log.slice(-20).map((e) => {
        const role = typeof e?.role === "string" ? e.role : "?";
        const text = typeof e?.text === "string" ? e.text : "";
        return `${role}: ${text.slice(0, 200)}`;
      });
      compactHistory = last.join("\n");
    }
  } catch {
    // ignore
  }

  return { activeProfile, preferences, savedPlacesRaw, compactHistory };
}
