# openclaw-lullabully

AI sleep enforcer plugin for [OpenClaw](https://openclaw.ai). Sends escalating messages from gentle reminders to nuclear-level harassment until you actually go to bed.

Lullabully is an angry teddy bear who cares too much.

## Escalation Ladder

| Level | Timing | Vibe |
|-------|--------|------|
| Reset | bedtime - 3h | Clears state for tonight |
| L1 Gentle | bedtime | Warm 1-liner from a friend |
| L2 Passive-Aggressive | +10 min | Guilt trips, disappointment |
| L3 Annoying | +20 min | Multi-message spam, sleep facts |
| L4 Mean | +30 min | Comedy roast, cutting humor |
| L5 Nuclear (x4) | +40/45/50/55 min | ALL CAPS, fake threats, existential crisis |
| L5 Midnight | 00:00 | Grand finale |

Each level checks if you've confirmed sleep. If you argued back, it skips ahead to a harsher level.

## Install

```bash
openclaw plugins install openclaw-lullabully
```

Or install from a local path:

```bash
openclaw plugins install --link ./openclaw-lullabully
```

## Setup

After installing, just type `/lullabully setup` from your Telegram chat:

```
/lullabully setup Alex
/lullabully setup Alex 23:30
```

That's it! The plugin auto-detects your chat ID and channel from the message. If you don't specify a bedtime, it defaults to 23:00.

To change settings later:

```
/lullabully bedtime 23:30
/lullabully timezone Europe/Paris
```

### Manual Configuration (alternative)

If you prefer to configure via the terminal:

```bash
openclaw config set plugins.entries.openclaw-lullabully.config.name '"YourName"'
openclaw config set plugins.entries.openclaw-lullabully.config.chatId '"YOUR_CHAT_ID"'
```

Optional settings (with defaults):

```bash
openclaw config set plugins.entries.openclaw-lullabully.config.bedtime '"23:00"'
openclaw config set plugins.entries.openclaw-lullabully.config.timezone '"America/New_York"'
openclaw config set plugins.entries.openclaw-lullabully.config.channel '"telegram"'
```

## What Happens

On gateway start, the plugin automatically creates cron jobs (up to 10, depending on bedtime):

```
openclaw cron list
```

The agent session handles sleep confirmations when you reply during the bedtime window:
- **"goodnight"**, **"ok ok"**, **"I'm in bed"** → confirms sleep, stops escalation
- **"no"**, **"5 more minutes"**, **"shut up"** → escalates aggression
- **"turn off lullabully"** → disables until re-enabled

## Commands

Type these in your chat:

| Command | What it does |
|---------|-------------|
| `/lullabully` | Show current status |
| `/lullabully config` | Show all config values |
| `/lullabully schedules` | Show cron schedule for each level |
| `/lullabully bedtime 23:30` | Change bedtime (saves + re-syncs) |
| `/lullabully timezone Europe/Paris` | Change timezone (saves + re-syncs) |
| `/lullabully setup Alex` | Initial setup (auto-detects chat ID, bedtime defaults to 23:00) |
| `/lullabully setup Alex 23:30` | Setup with custom bedtime |

## Manual Re-sync

Config changes via `/lullabully bedtime` and `/lullabully timezone` auto-sync cron jobs immediately. If you change config via the terminal, jobs update on next gateway restart, or force an immediate re-sync:

```bash
openclaw gateway call lullabully.sync
```

## Config Reference

| Key | Type | Required | Default | Description |
|-----|------|----------|---------|-------------|
| `name` | string | yes | — | Your name (used in messages) |
| `chatId` | string | yes | — | Chat/channel ID for messages |
| `bedtime` | string | no | `23:00` | Bedtime in HH:MM format |
| `timezone` | string | no | system timezone | IANA timezone (auto-detected) |
| `channel` | string | no | `telegram` | Messaging channel |
| `enabled` | boolean | no | `true` | Enable/disable all jobs |

## Uninstall

```bash
openclaw plugins uninstall openclaw-lullabully
```

Then remove leftover cron jobs (if any remain):

```bash
openclaw cron list                    # find lullabully-* job IDs
openclaw cron remove <job-id>         # remove each one
```

## License

MIT
