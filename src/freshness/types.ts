import type { OutputSelectorState } from '../types';

export interface FileRecord {
  path: string;
  mtime?: number;
  size?: number;
}

export interface PackRecord {
  name: string;
  source: {
    type: 'folder' | 'tag' | 'moc' | 'daily';
    query: string;
  };
  target: 'chatgpt' | 'claude' | 'gemini' | 'notebooklm';
  createdAt?: number;
  files: FileRecord[];
  outputSelectorState?: OutputSelectorState;
}

export type FreshnessLevel = 'fresh' | 'warn' | 'stale';

export interface PackCheckResult {
  key: string;
  level: FreshnessLevel;
  freshnessScore: number;
  matchedCount: number;
  unchanged: string[];
  updated: string[];
  added: string[];
  missing: string[];
  tokenCount?: number;
  contextLimit?: number;
}

export interface FreshnessSettings {
  warnThreshold: number;
  staleThreshold: number;
}

export const DEFAULT_FRESHNESS_SETTINGS: FreshnessSettings = {
  warnThreshold: 0.01,
  staleThreshold: 0.20,
};

export const TARGET_LABEL: Record<PackRecord['target'], string> = {
  chatgpt:    'ChatGPT Projects',
  claude:     'Claude Project',
  gemini:     'Gemini',
  notebooklm: 'NotebookLM',
};

export const TARGET_CONTEXT_LIMIT: Record<PackRecord['target'], number> = {
  chatgpt:    128_000,
  claude:     200_000,
  gemini:   1_000_000,
  notebooklm: 500_000,
};

export function formatTokenBudget(tokens: number): string {
  if (tokens >= 1_000_000) {
    const val = tokens / 1_000_000;
    return `${val % 1 === 0 ? val.toFixed(0) : val.toFixed(1)}M`;
  }
  if (tokens >= 10_000) {
    const val = tokens / 1_000;
    return `${val % 1 === 0 ? val.toFixed(0) : val.toFixed(1)}k`;
  }
  if (tokens >= 1_000) {
    const val = tokens / 1_000;
    return `${val.toFixed(1)}k`;
  }
  return String(tokens);
}
