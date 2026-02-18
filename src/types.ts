export interface LullabullyConfig {
  name: string;
  bedtime: string; // HH:MM format
  timezone: string; // IANA timezone
  channel: string; // e.g. "telegram"
  chatId: string;
  enabled: boolean;
  /** Resolved absolute path to the state file (set at runtime by plugin register) */
  stateFilePath: string;
}

export interface LullabullyState {
  /** ISO date string of when user confirmed sleep (e.g. "2026-02-17") */
  lastSleepConfirmed: string | null;
  /** Current escalation level (0 = not started, 1-5 = active) */
  currentLevel: number;
  /** Whether the harasser is currently active for tonight */
  activeTonight: boolean;
  /** ISO timestamp of last state update */
  updatedAt: string;
}

export const DEFAULT_STATE: LullabullyState = {
  lastSleepConfirmed: null,
  currentLevel: 0,
  activeTonight: false,
  updatedAt: new Date().toISOString(),
};

export interface ScheduleEntry {
  name: string;
  level: number;
  cronExpr: string;
  description: string;
}

export type EscalationLevel =
  | "reset"
  | "L1-gentle"
  | "L2-passive-aggressive"
  | "L3-annoying"
  | "L4-mean"
  | "L5-nuclear-1"
  | "L5-nuclear-2"
  | "L5-nuclear-3"
  | "L5-nuclear-4"
  | "L5-midnight";
