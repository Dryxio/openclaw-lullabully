import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import type { OpenClawPluginApi, GatewayRequestHandlerOptions, OpenClawConfig } from "openclaw/plugin-sdk";
import type { LullabullyConfig } from "./types.js";
import { computeSchedules } from "./schedules.js";
import { getPromptForJob } from "./prompts.js";
import { generateAgentContext } from "./agent-context.js";

// ─── Types for file-based cron sync ─────────────────────────────────
// These match the CronStoreFile format that CronService reads from disk.
// Only used for the pre-load file sync; the gateway method uses the
// CronService API directly.

interface CronJobRecord {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  createdAtMs: number;
  updatedAtMs: number;
  schedule: { kind: "cron"; expr: string; tz?: string };
  sessionTarget: "main" | "isolated";
  wakeMode: "next-heartbeat" | "now";
  payload: { kind: "agentTurn"; message: string; timeoutSeconds?: number };
  delivery?: { mode: string; channel?: string; to?: string; bestEffort?: boolean };
  state: Record<string, unknown>;
}

interface CronStoreFile {
  version: 1;
  jobs: CronJobRecord[];
}

type CronJobInput = Omit<CronJobRecord, "id" | "createdAtMs" | "updatedAtMs" | "state">;

// ─── Cron Store Path Resolution ─────────────────────────────────────
// Replicates OpenClaw's resolveCronStorePath() logic so the plugin
// writes to the same file the CronService will later load.

const LULLABULLY_PREFIX = "lullabully-";

function expandHome(input: string): string {
  if (input.startsWith("~")) {
    return join(homedir(), input.slice(1));
  }
  return input;
}

function resolveCronStorePath(cronStoreConfig: string | undefined, stateDir: string): string {
  if (cronStoreConfig?.trim()) {
    return resolve(expandHome(cronStoreConfig.trim()));
  }
  return join(stateDir, "cron", "jobs.json");
}

// ─── File-based Cron Sync ───────────────────────────────────────────

function readCronStore(storePath: string): CronStoreFile {
  if (!existsSync(storePath)) {
    return { version: 1, jobs: [] };
  }
  return JSON.parse(readFileSync(storePath, "utf-8")) as CronStoreFile;
}

function writeCronStore(storePath: string, store: CronStoreFile): void {
  const dir = dirname(storePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(storePath, JSON.stringify(store, null, 2) + "\n", "utf-8");
}

function buildJobData(
  scheduleName: string,
  scheduleDesc: string,
  cronExpr: string,
  config: LullabullyConfig,
): CronJobInput {
  return {
    name: scheduleName,
    description: scheduleDesc,
    enabled: config.enabled,
    schedule: { kind: "cron", expr: cronExpr, tz: config.timezone },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: {
      kind: "agentTurn",
      message: getPromptForJob(scheduleName, config),
      timeoutSeconds: 120,
    },
    delivery: {
      mode: "none" as const,
      channel: config.channel,
      to: config.chatId,
      bestEffort: true,
    },
  };
}

function syncCronJobsFromFile(
  storePath: string,
  config: LullabullyConfig,
  logger: { info: (msg: string) => void },
): { created: number; updated: number; removed: number } {
  const store = readCronStore(storePath);
  const desiredSchedules = computeSchedules(config.bedtime);
  const stats = { created: 0, updated: 0, removed: 0 };

  const existingByName = new Map<string, CronJobRecord>();
  for (const job of store.jobs) {
    if (job.name.startsWith(LULLABULLY_PREFIX)) {
      existingByName.set(job.name, job);
    }
  }

  const now = Date.now();

  for (const schedule of desiredSchedules) {
    const existing = existingByName.get(schedule.name);
    if (existing) {
      const data = buildJobData(schedule.name, schedule.description, schedule.cronExpr, config);
      const needsUpdate =
        existing.schedule.expr !== schedule.cronExpr ||
        existing.schedule.tz !== config.timezone ||
        existing.enabled !== config.enabled ||
        existing.delivery?.to !== config.chatId ||
        existing.delivery?.channel !== config.channel ||
        existing.payload.message !== data.payload.message;

      if (needsUpdate) {
        Object.assign(existing, data, { updatedAtMs: now });
        stats.updated++;
      }
      existingByName.delete(schedule.name);
    } else {
      const data = buildJobData(schedule.name, schedule.description, schedule.cronExpr, config);
      const newJob: CronJobRecord = {
        id: randomUUID(),
        ...data,
        createdAtMs: now,
        updatedAtMs: now,
        state: {},
      };
      store.jobs.push(newJob);
      stats.created++;
    }
  }

  for (const [name, staleJob] of existingByName) {
    logger.info(`Removing stale lullabully job: ${name}`);
    store.jobs = store.jobs.filter((j: CronJobRecord) => j.id !== staleJob.id);
    stats.removed++;
  }

  writeCronStore(storePath, store);
  return stats;
}

// ─── Gateway Method (for manual re-sync via CronService API) ────────

async function syncCronJobsViaService(
  cron: GatewayRequestHandlerOptions["context"]["cron"],
  config: LullabullyConfig,
  logger: { info: (msg: string) => void },
): Promise<{ created: number; updated: number; removed: number }> {
  const existing = await cron.list({ includeDisabled: true });
  const lullabullyJobs = existing.filter((j) => j.name.startsWith(LULLABULLY_PREFIX));
  const desiredSchedules = computeSchedules(config.bedtime);
  const stats = { created: 0, updated: 0, removed: 0 };

  const existingByName = new Map<string, (typeof existing)[number]>();
  for (const job of lullabullyJobs) {
    existingByName.set(job.name, job);
  }

  for (const schedule of desiredSchedules) {
    const data = buildJobData(schedule.name, schedule.description, schedule.cronExpr, config);
    const existingJob = existingByName.get(schedule.name);
    if (existingJob) {
      const sched = existingJob.schedule;
      const pay = existingJob.payload;
      const needsUpdate =
        (sched.kind === "cron" ? sched.expr : "") !== schedule.cronExpr ||
        (sched.kind === "cron" ? sched.tz : "") !== config.timezone ||
        existingJob.enabled !== config.enabled ||
        existingJob.delivery?.to !== config.chatId ||
        existingJob.delivery?.channel !== config.channel ||
        (pay.kind === "agentTurn" ? pay.message : "") !== data.payload.message;

      if (needsUpdate) {
        await cron.update(existingJob.id, data as Parameters<typeof cron.update>[1]);
        stats.updated++;
      }
      existingByName.delete(schedule.name);
    } else {
      await cron.add(data as Parameters<typeof cron.add>[0]);
      stats.created++;
    }
  }

  for (const [name, staleJob] of existingByName) {
    logger.info(`Removing stale job: ${name}`);
    await cron.remove(staleJob.id);
    stats.removed++;
  }

  return stats;
}

// ─── Config Persistence ─────────────────────────────────────────────

const PLUGIN_CONFIG_PATH = ["plugins", "entries", "openclaw-lullabully", "config"] as const;

async function persistPluginConfig(
  api: OpenClawPluginApi,
  updates: Partial<Omit<LullabullyConfig, "stateFilePath">>,
): Promise<void> {
  const cfg = api.runtime.config.loadConfig() as Record<string, unknown>;
  // Walk to plugins.entries.openclaw-lullabully.config, creating along the way
  let cursor: Record<string, unknown> = cfg;
  for (const key of PLUGIN_CONFIG_PATH) {
    if (!cursor[key] || typeof cursor[key] !== "object") {
      cursor[key] = {};
    }
    cursor = cursor[key] as Record<string, unknown>;
  }
  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      cursor[key] = value;
    }
  }
  await api.runtime.config.writeConfigFile(cfg as OpenClawConfig);
}

// ─── Slash Command Handler ──────────────────────────────────────────

interface CommandState {
  config: LullabullyConfig;
  configValid: boolean;
  cronStorePath: string;
}

async function handleCommand(
  ctx: { args?: string; senderId?: string; from?: string; channel: string },
  state: CommandState,
  api: OpenClawPluginApi,
): Promise<{ text: string }> {
  const rawArgs = ctx.args?.trim() || "";
  const parts = rawArgs.split(/\s+/);
  const subcommand = parts[0]?.toLowerCase() || "";
  const { config } = state;

  // If unconfigured and not running setup, nudge toward it
  if (!state.configValid && subcommand !== "setup") {
    return {
      text: [
        `Hey. I'm Lullabully. I yell at you until you go to sleep.`,
        ``,
        `Want me to bully you into bed every night? Tell me your name and when you sleep:`,
        ``,
        `\`/lullabully setup YourName 23:00\``,
      ].join("\n"),
    };
  }

  switch (subcommand) {
    case "":
    case "status": {
      const schedules = computeSchedules(config.bedtime);
      if (!config.enabled) {
        return { text: `I'm off right now. You're on your own, ${config.name}. Don't come crying to me when you're up at 3am.` };
      }
      return {
        text: [
          `I'm watching you, ${config.name}.`,
          `Every night at **${config.bedtime}** (${config.timezone}), the harassment begins.`,
          `${schedules.length} escalation stages. You won't last past level 3.`,
        ].join("\n"),
      };
    }

    case "config": {
      return {
        text: [
          `**Lullabully Config**`,
          `- Name: ${config.name}`,
          `- Bedtime: ${config.bedtime}`,
          `- Timezone: ${config.timezone}`,
          `- Channel: ${config.channel}`,
          `- Chat ID: ${config.chatId}`,
          `- Enabled: ${config.enabled}`,
        ].join("\n"),
      };
    }

    case "schedules": {
      const schedules = computeSchedules(config.bedtime);
      const lines = [`**Lullabully Schedules** (bedtime: ${config.bedtime} ${config.timezone})`, ""];
      for (const s of schedules) {
        lines.push(`- \`${s.cronExpr}\` \u2014 ${s.name} (L${s.level}) \u2014 ${s.description}`);
      }
      return { text: lines.join("\n") };
    }

    case "bedtime": {
      const newBedtime = parts[1];
      if (!newBedtime) {
        return { text: `Your bedtime is **${config.bedtime}**. Want to change it? \`/lullabully bedtime 23:30\`` };
      }
      if (!/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/.test(newBedtime)) {
        return { text: `That's not a time, ${config.name}. Use HH:MM like \`23:30\` or \`01:00\`.` };
      }

      config.bedtime = newBedtime;
      try {
        await persistPluginConfig(api, { bedtime: newBedtime });
      } catch (err) {
        return { text: `Failed to save bedtime: ${err}` };
      }

      if (state.configValid) {
        try {
          syncCronJobsFromFile(state.cronStorePath, config, api.logger);
        } catch (err) {
          api.logger.error(`Lullabully cron re-sync failed: ${err}`);
        }
      }

      return { text: `Fine. **${newBedtime}** it is. I'll be there. Every. Single. Night.` };
    }

    case "setup": {
      const setupArgs = parts.slice(1);
      // If last arg matches HH:MM, treat it as bedtime
      const timePattern = /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/;
      let bedtime: string | undefined;
      if (setupArgs.length > 0 && timePattern.test(setupArgs[setupArgs.length - 1])) {
        bedtime = setupArgs.pop()!;
      }
      const name = setupArgs.join(" ").trim();

      if (!name) {
        return {
          text: [
            `Tell me your name so I know who to yell at.`,
            ``,
            `\`/lullabully setup YourName 23:00\``,
          ].join("\n"),
        };
      }

      const chatId = ctx.from || ctx.senderId || "";
      const channel = ctx.channel || "telegram";

      if (!chatId) {
        return { text: `I can't find you. Send this from Telegram so I know where to harass you.` };
      }

      config.name = name;
      config.chatId = chatId;
      config.channel = channel;
      if (bedtime) config.bedtime = bedtime;

      const updates: Partial<Omit<LullabullyConfig, "stateFilePath">> = { name, chatId, channel };
      if (bedtime) updates.bedtime = bedtime;
      try {
        await persistPluginConfig(api, updates);
      } catch (err) {
        return { text: `Something broke. Try again: ${err}` };
      }

      state.configValid = true;
      try {
        const stats = syncCronJobsFromFile(state.cronStorePath, config, api.logger);
        api.logger.info(
          `Lullabully setup sync: ${stats.created} created, ${stats.updated} updated, ${stats.removed} removed`,
        );
      } catch (err) {
        api.logger.error(`Lullabully post-setup sync failed: ${err}`);
      }

      return {
        text: [
          `Alright ${name}, you asked for it.`,
          ``,
          `Every night at **${config.bedtime}** I start checking on you. Ignore me and I get worse. By midnight you'll wish you'd just gone to bed.`,
          ``,
          `Change your bedtime anytime: \`/lullabully bedtime 23:30\``,
        ].join("\n"),
      };
    }

    case "timezone": {
      const newTz = parts[1];
      if (!newTz) {
        return { text: `You're on **${config.timezone}** time. Change it: \`/lullabully timezone Europe/Paris\`` };
      }

      config.timezone = newTz;
      try {
        await persistPluginConfig(api, { timezone: newTz });
      } catch (err) {
        return { text: `Failed to save timezone: ${err}` };
      }

      if (state.configValid) {
        try {
          syncCronJobsFromFile(state.cronStorePath, config, api.logger);
        } catch (err) {
          api.logger.error(`Lullabully cron re-sync failed: ${err}`);
        }
      }

      return { text: `Got it. **${newTz}**. No matter where you run, I'll find you at bedtime.` };
    }

    default:
      return {
        text: [
          `I don't know what "${subcommand}" means. Here's what I understand:`,
          ``,
          `\`/lullabully\` \u2014 Am I watching you?`,
          `\`/lullabully bedtime 23:30\` \u2014 Change when I start yelling`,
          `\`/lullabully timezone Europe/Paris\` \u2014 Change your timezone`,
          `\`/lullabully schedules\` \u2014 See my full escalation plan`,
          `\`/lullabully config\` \u2014 See all settings`,
          `\`/lullabully setup Alex 23:00\` \u2014 Start over`,
        ].join("\n"),
      };
  }
}

// ─── Plugin Entry Point ─────────────────────────────────────────────

const lullabullyPlugin = {
  id: "openclaw-lullabully",
  name: "Lullabully",
  description: "AI sleep enforcer that escalates from gentle to nuclear until you go to bed",

  register(api: OpenClawPluginApi) {
    const raw = api.pluginConfig ?? {};
    const stateDir = api.runtime.state.resolveStateDir();
    const config: LullabullyConfig = {
      name: (raw["name"] as string) || "",
      bedtime: (raw["bedtime"] as string) || "23:00",
      timezone: (raw["timezone"] as string) || Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York",
      channel: (raw["channel"] as string) || "telegram",
      chatId: (raw["chatId"] as string) || "",
      enabled: raw["enabled"] !== false,
      stateFilePath: join(stateDir, "lullabully-state.json"),
    };

    if (!config.name || !config.chatId) {
      api.logger.info(
        "openclaw-lullabully: config incomplete — run /lullabully setup YourName from chat to auto-configure",
      );
    }

    // Resolve cron store path from OpenClaw config (respects cron.store override)
    const ocConfig = api.config as OpenClawConfig;
    const cronStorePath = resolveCronStorePath(ocConfig.cron?.store, stateDir);

    // Mutable state shared between command handler and hooks
    const state: CommandState = {
      config,
      configValid: !!config.name && !!config.chatId,
      cronStorePath,
    };

    // Sync cron jobs to file during plugin registration (before CronService loads)
    if (state.configValid) {
      try {
        const stats = syncCronJobsFromFile(cronStorePath, config, api.logger);
        api.logger.info(
          `Lullabully cron sync: ${stats.created} created, ${stats.updated} updated, ${stats.removed} removed`,
        );
      } catch (err) {
        api.logger.error(`Lullabully cron sync failed: ${err}`);
      }
    }

    // Gateway method for manual re-sync (uses proper CronService API)
    api.registerGatewayMethod("lullabully.sync", async ({ context, respond }: GatewayRequestHandlerOptions) => {
      if (!state.configValid) {
        respond(false, { error: "Plugin config incomplete — run /lullabully setup YourName" });
        return;
      }
      try {
        const stats = await syncCronJobsViaService(context.cron, config, api.logger);
        api.logger.info(
          `Lullabully sync: ${stats.created} created, ${stats.updated} updated, ${stats.removed} removed`,
        );
        respond(true, { ok: true, ...stats });
      } catch (err) {
        api.logger.error(`Lullabully sync failed: ${err}`);
        respond(false, { error: String(err) });
      }
    });

    // Register slash command (async handler with auto-setup support)
    api.registerCommand({
      name: "lullabully",
      description: "Sleep enforcer — status, config, schedules, setup, bedtime",
      acceptsArgs: true,
      handler: (ctx) => handleCommand(ctx, state, api),
    });

    // Inject Lullabully context into agent system prompt
    // Registered unconditionally — checks configValid at call time so setup activates it
    api.on("before_agent_start", () => {
      if (!state.configValid) return {};
      return { prependContext: generateAgentContext(config) };
    });
  },
};

export default lullabullyPlugin;
