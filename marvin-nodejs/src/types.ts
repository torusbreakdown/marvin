/**
 * Core type definitions for Marvin Node.js implementation
 * Based on MARVIN_API_SPEC.md and TOOLS.md
 */

// ============================================================================
// Profile & Preferences Types
// ============================================================================

export interface UserPreferences {
  dietary: string[];
  spice_tolerance: 'none' | 'mild' | 'medium' | 'hot' | 'extra_hot';
  favorite_cuisines: string[];
  avoid_cuisines: string[];
  has_car: boolean;
  max_distance_km: number;
  budget: 'cheap' | 'moderate' | 'expensive' | 'any';
  accessibility: string[];
  notes: string;
}

export interface SavedPlace {
  label: string;
  name?: string;
  address?: string;
  phone?: string;
  website?: string;
  lat?: number;
  lng?: number;
  notes?: string;
}

export interface Profile {
  name: string;
  preferences: UserPreferences;
  savedPlaces: SavedPlace[];
}

// ============================================================================
// Chat & History Types
// ============================================================================

export interface ChatLogEntry {
  role: 'you' | 'assistant' | 'system';
  text: string;
  time: string;
}

// ============================================================================
// Tool Types
// ============================================================================

export interface ToolParameter {
  name: string;
  type: string;
  description: string;
  required: boolean;
  default?: unknown;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: ToolParameter[];
}

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  success: boolean;
  result: string;
  error?: string;
}

// ============================================================================
// LLM Provider Types
// ============================================================================

export type LLMProvider = 'copilot' | 'openai' | 'anthropic' | 'gemini' | 'groq' | 'ollama';

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface LLMStreamChunk {
  content: string;
  done: boolean;
  toolCalls?: ToolCall[];
}

export interface CostInfo {
  session_cost: number;
  llm_turns: number;
  model_turns: Record<string, number>;
  model_cost: Record<string, number>;
}

// ============================================================================
// CLI Arguments Types
// ============================================================================

export interface CliArgs {
  nonInteractive?: boolean;
  workingDir?: string;
  designFirst?: boolean;
  prompt?: string;
  ntfy?: string;
  provider?: LLMProvider;
  model?: string;
  plain?: boolean;
  curses?: boolean;
}

// ============================================================================
// Pipeline Types
// ============================================================================

export type PipelinePhase = 
  | '1a' | '1a_review' 
  | '1b' | '1b_review' 
  | '2a' | '2b' 
  | '3' 
  | '4a' | '4b' | '4c' 
  | '5';

export interface PipelineState {
  currentPhase: PipelinePhase;
  completedPhases: PipelinePhase[];
}

// ============================================================================
// Location Types
// ============================================================================

export interface Location {
  lat: number;
  lng: number;
  source: 'device' | 'ip' | 'manual';
}

// ============================================================================
// Place Search Types
// ============================================================================

export interface Place {
  id: string;
  name: string;
  address?: string;
  lat?: number;
  lng?: number;
  rating?: number;
  phone?: string;
  website?: string;
  types?: string[];
}

// ============================================================================
// API Response Types
// ============================================================================

export interface WeatherData {
  temperature: number;
  conditions: string;
  humidity?: number;
  windSpeed?: number;
  forecast: Array<{
    date: string;
    temp: number;
    conditions: string;
  }>;
}

export interface TravelTime {
  duration_seconds: number;
  distance_meters: number;
  mode: string;
}

// ============================================================================
// Ticket System Types
// ============================================================================

export type TicketType = 'bug' | 'feature' | 'task' | 'epic' | 'chore';
export type TicketStatus = 'open' | 'in_progress' | 'closed';

export interface Ticket {
  id: string;
  title: string;
  description: string;
  type: TicketType;
  status: TicketStatus;
  priority: number;
  tags: string[];
  parent?: string;
  dependencies: string[];
  notes: string[];
  created: string;
  updated: string;
}

// ============================================================================
// Environment Variables
// ============================================================================

export interface MarvinEnv {
  // Provider Selection
  LLM_PROVIDER?: string;
  
  // Model Configuration
  MARVIN_MODEL?: string;
  MARVIN_CODE_MODEL_HIGH?: string;
  MARVIN_CODE_MODEL_LOW?: string;
  MARVIN_CODE_MODEL_PLAN?: string;
  MARVIN_CODE_MODEL_PLAN_GEN?: string;
  MARVIN_CODE_MODEL_TEST_WRITER?: string;
  MARVIN_CODE_MODEL_AUX_REVIEWER?: string;
  
  // Provider API Keys
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  GEMINI_API_KEY?: string;
  GROQ_API_KEY?: string;
  
  // Provider Config
  GROQ_MODEL?: string;
  GEMINI_MODEL?: string;
  OLLAMA_MODEL?: string;
  OLLAMA_URL?: string;
  OPENAI_COMPAT_URL?: string;
  OPENAI_COMPAT_API_KEY?: string;
  
  // Behavior
  MARVIN_DEPTH?: string;
  MARVIN_DEBUG_ROUNDS?: string;
  MARVIN_E2E_ROUNDS?: string;
  MARVIN_FE_ROUNDS?: string;
  MARVIN_QA_ROUNDS?: string;
  MARVIN_READONLY?: string;
  MARVIN_SUBAGENT_LOG?: string;
  MARVIN_TICKET?: string;
  
  // External Services
  GOOGLE_PLACES_API_KEY?: string;
  GNEWS_API_KEY?: string;
  NEWSAPI_KEY?: string;
  OMDB_API_KEY?: string;
  RAWG_API_KEY?: string;
  STEAM_API_KEY?: string;
  
  // Editor
  EDITOR?: string;
}

// ============================================================================
// Config Paths
// ============================================================================

export const CONFIG_DIR = `${process.env.HOME || process.env.USERPROFILE}/.config/local-finder`;
export const NOTES_DIR = `${process.env.HOME || process.env.USERPROFILE}/Notes`;
export const DOWNLOADS_DIR = `${process.env.HOME || process.env.USERPROFILE}/Downloads`;
