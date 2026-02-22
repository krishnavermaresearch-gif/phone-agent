# 📱 Phone Agent

A multi-agent AI system that controls your Android phone via ADB, with Telegram as the user interface and Ollama (local LLM) as the AI brain.

```
You on Telegram  →  Telegram Bot  →  Ollama (local AI)  →  ADB  →  📱 Your Phone
```

## Features

- **Full phone control** — tap, swipe, type, take screenshots, run shell commands
- **UI understanding** — reads the accessibility tree to "see" what's on screen
- **Multi-agent orchestrator** — breaks complex tasks into subtasks across apps
- **Plugin system** — WhatsApp, Instagram, Gmail plugins with deep-link navigation
- **Telegram interface** — control your phone from anywhere via Telegram
- **Local AI** — uses Ollama (free, private, runs on your machine)
- **Security** — blocked dangerous commands, optional user allowlist

## Prerequisites

1. **Node.js 22+** — [download](https://nodejs.org)
2. **ADB** — [download](https://developer.android.com/tools/releases/platform-tools) and add to PATH
3. **Ollama** — [download](https://ollama.com)
4. **Android phone** with USB Debugging enabled

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Pull an Ollama model (pick one)
ollama pull qwen2.5        # Recommended for tool calling
# OR
ollama pull llama3.1

# 3. Create a Telegram bot
# Open Telegram → search @BotFather → /newbot → copy the token

# 4. Configure
cp .env.example .env
# Edit .env and add your TELEGRAM_BOT_TOKEN

# 5. Connect your phone via USB
adb devices   # Should show your device

# 6. Start the agent
npx tsx src/index.ts
```

## Usage

Send messages to your Telegram bot:

| Message | What it does |
|---------|-------------|
| `"take a screenshot"` | Captures and sends the current screen |
| `"open YouTube"` | Launches YouTube app |
| `"what apps are installed?"` | Lists installed apps |
| `"open WhatsApp and read my recent messages"` | Opens WhatsApp, reads chat list |
| `"open Settings and check battery"` | Navigates to battery settings |
| `"send WhatsApp to Mom: I'll be late"` | Sends a WhatsApp message |

### Commands

- `/start` — Device info + welcome
- `/screenshot` — Quick screenshot
- `/status` — Battery, current app, WiFi
- `/plugins` — Available plugins and tools
- `/stop` — Cancel running task
- `/help` — Usage guide

## Plugins

| Plugin | Package | Tools |
|--------|---------|-------|
| WhatsApp | `com.whatsapp` | open, send, read_chats |
| Instagram | `com.instagram.android` | open, search, follow, view_profile |
| Gmail | `com.google.android.gm` | open, compose, read_inbox |

### Adding a Plugin

Create a new folder in `src/plugins/<name>/index.ts`:

```typescript
import type { PhonePlugin } from "../plugin-types.js";

export const myPlugin: PhonePlugin = {
  name: "myapp",
  description: "What it does",
  appPackage: "com.example.myapp",
  tools: [/* your tool definitions */],
  systemPrompt: "Instructions for the AI on how to use this app",
};
```

Then add it to `src/plugins/loader.ts`.

## Architecture

```
phone-agent/
├── src/
│   ├── index.ts              # Entry point + pre-flight checks
│   ├── logger.ts             # Structured logging
│   ├── adb/
│   │   ├── connection.ts     # ADB wrapper (shell, screencap, input, files)
│   │   └── device-info.ts    # Device specs collector
│   ├── tools/                # Core tools available to all agents
│   │   ├── screenshot.ts     # Screen capture + resize
│   │   ├── ui-tree.ts        # UI accessibility tree parser
│   │   ├── input.ts          # Tap, swipe, type, key, long-press, wait
│   │   ├── shell.ts          # Linux shell commands (with security)
│   │   └── apps.ts           # App management (list, launch, stop, info)
│   ├── plugins/              # App-specific automation
│   │   ├── plugin-types.ts   # Plugin interface
│   │   ├── loader.ts         # Plugin discovery
│   │   ├── whatsapp/         # WhatsApp automation
│   │   ├── instagram/        # Instagram automation
│   │   └── gmail/            # Gmail automation
│   ├── agent/                # AI brain
│   │   ├── ollama-client.ts  # Ollama HTTP API client
│   │   ├── system-prompt.ts  # Device-aware system prompts
│   │   ├── tool-registry.ts  # Tool definitions + Ollama format
│   │   ├── runner.ts         # Agent loop (observe → plan → act → verify)
│   │   └── orchestrator.ts   # Multi-agent task decomposition
│   └── telegram/
│       └── bot.ts            # Telegram bot interface
```

## License

MIT
