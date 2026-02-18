import type { ScheduleEntry } from "./types.js";

/**
 * Parse "HH:MM" string into hours and minutes.
 */
function parseBedtime(bedtime: string): { hours: number; minutes: number } {
  const [h, m] = bedtime.split(":").map(Number);
  if (isNaN(h) || isNaN(m) || h < 0 || h > 23 || m < 0 || m > 59) {
    throw new Error(`Invalid bedtime format: "${bedtime}". Expected HH:MM (e.g. "23:00")`);
  }
  return { hours: h, minutes: m };
}

/**
 * Add minutes to a time, wrapping at 24h. Returns { hours, minutes }.
 */
function addMinutes(
  hours: number,
  minutes: number,
  offsetMinutes: number
): { hours: number; minutes: number } {
  let totalMinutes = hours * 60 + minutes + offsetMinutes;
  // Handle negative wrap (for reset which is bedtime - 180min)
  while (totalMinutes < 0) totalMinutes += 24 * 60;
  totalMinutes = totalMinutes % (24 * 60);
  return {
    hours: Math.floor(totalMinutes / 60),
    minutes: totalMinutes % 60,
  };
}

/**
 * Convert hours/minutes to a cron expression: "M H * * *"
 */
function toCron(hours: number, minutes: number): string {
  return `${minutes} ${hours} * * *`;
}

/**
 * Compute all 10 cron schedule entries from a bedtime string.
 *
 * Schedule offsets from bedtime:
 *   Reset:              -180 min (3 hours before)
 *   L1 Gentle:             0 min (at bedtime)
 *   L2 Passive-Aggressive: +10 min
 *   L3 Annoying:          +20 min
 *   L4 Mean:              +30 min
 *   L5 Nuclear 1:         +40 min
 *   L5 Nuclear 2:         +45 min
 *   L5 Nuclear 3:         +50 min
 *   L5 Nuclear 4:         +55 min
 *   L5 Midnight:          00:00 fixed
 */
export function computeSchedules(bedtime: string): ScheduleEntry[] {
  const { hours, minutes } = parseBedtime(bedtime);

  const offsets: Array<{
    name: string;
    level: number;
    offsetMin: number | null; // null = fixed midnight
    description: string;
  }> = [
    { name: "lullabully-reset", level: 0, offsetMin: -180, description: "Reset state (3h before bedtime)" },
    { name: "lullabully-L1-gentle", level: 1, offsetMin: 0, description: "Gentle reminder at bedtime" },
    { name: "lullabully-L2-passive-aggressive", level: 2, offsetMin: 10, description: "Passive-aggressive (+10min)" },
    { name: "lullabully-L3-annoying", level: 3, offsetMin: 20, description: "Annoying nudge (+20min)" },
    { name: "lullabully-L4-mean", level: 4, offsetMin: 30, description: "Mean warning (+30min)" },
    { name: "lullabully-L5-nuclear-1", level: 5, offsetMin: 40, description: "Nuclear wave 1 (+40min)" },
    { name: "lullabully-L5-nuclear-2", level: 5, offsetMin: 45, description: "Nuclear wave 2 (+45min)" },
    { name: "lullabully-L5-nuclear-3", level: 5, offsetMin: 50, description: "Nuclear wave 3 (+50min)" },
    { name: "lullabully-L5-nuclear-4", level: 5, offsetMin: 55, description: "Nuclear wave 4 (+55min)" },
    { name: "lullabully-L5-midnight", level: 5, offsetMin: null, description: "Midnight nuclear finale" },
  ];

  // Skip midnight finale if bedtime is after midnight (would fire before bedtime)
  const isAfterMidnight = hours < 4; // bedtimes like 00:00–03:59

  return offsets
    .filter(({ offsetMin }) => !(offsetMin === null && isAfterMidnight))
    .map(({ name, level, offsetMin, description }) => {
      let cronExpr: string;
      if (offsetMin === null) {
        // Fixed midnight
        cronExpr = toCron(0, 0);
      } else {
        const t = addMinutes(hours, minutes, offsetMin);
        cronExpr = toCron(t.hours, t.minutes);
      }
      return { name, level, cronExpr, description };
    });
}
