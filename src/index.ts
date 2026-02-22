#!/usr/bin/env node

/**
 * Phone Agent — Entry Point
 *
 * Multi-agent AI phone controller via ADB
 * Telegram UI + Ollama (local LLM) + ADB
 *
 * Usage:
 *   npx tsx src/index.ts
 *
 * Prerequisites:
 *   1. ADB installed and phone connected (USB Debugging enabled)
 *   2. Ollama running with a tool-capable model (qwen2.5, llama3.1)
 *   3. TELEGRAM_BOT_TOKEN set in .env or environment
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { logError, logInfo, setLogLevel } from "./logger.js";
import { getAdb } from "./adb/connection.js";
import { getLLMProvider } from "./llm/provider-factory.js";
import { getOrchestrator } from "./agent/orchestrator.js";
import { PhoneAgentBot } from "./telegram/bot.js";
import { getCronScheduler } from "./cron/scheduler.js";
import { getSelfHealer } from "./autonomy/self-healing.js";
import { getEventMonitor } from "./autonomy/event-monitor.js";
import { getAgendaManager } from "./autonomy/agenda.js";
import { getOAuthServer } from "./oauth/oauth-server.js";

// ─── Load .env ───────────────────────────────────────────────────────────────

function loadEnv(): void {
    const envPath = resolve(process.cwd(), ".env");
    if (!existsSync(envPath)) return;

    try {
        const content = readFileSync(envPath, "utf-8");
        for (const line of content.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith("#")) continue;
            const eqIndex = trimmed.indexOf("=");
            if (eqIndex === -1) continue;
            const key = trimmed.slice(0, eqIndex).trim();
            const value = trimmed.slice(eqIndex + 1).trim();
            if (key && !(key in process.env)) {
                process.env[key] = value;
            }
        }
    } catch {
        // Ignore .env read errors
    }
}

// ─── Startup Checks ─────────────────────────────────────────────────────────

async function checkAdb(): Promise<boolean> {
    logInfo("Checking ADB connection...");
    try {
        const adb = getAdb();
        const device = await adb.connect();
        logInfo(`✅ ADB connected: ${device.serial} (${device.model ?? "unknown"})`);
        return true;
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logError(`❌ ADB check failed: ${msg}`);
        return false;
    }
}

async function checkLLM(): Promise<boolean> {
    const llm = getLLMProvider();
    logInfo(`Checking ${llm.name} connection (model: ${llm.getModel()})...`);
    const health = await llm.healthCheck();
    if (health.ok) {
        logInfo(`✅ ${llm.name} connected: model=${llm.getModel()}`);
        return true;
    } else {
        logError(`❌ ${llm.name} check failed: ${health.error}`);
        return false;
    }
}

function checkTelegramToken(): string | null {
    const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
    if (!token) {
        logError(
            "❌ TELEGRAM_BOT_TOKEN not set. Get one from @BotFather on Telegram.\n" +
            "   Set it in .env file or as environment variable.",
        );
        return null;
    }
    logInfo("✅ Telegram bot token found");
    return token;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    console.log(`Phone Agent starting...`);

    // Load environment variables
    loadEnv();

    // Set log level
    if (process.env.LOG_LEVEL) {
        setLogLevel(process.env.LOG_LEVEL as any);
    }

    // ── Pre-flight checks ──
    logInfo("Running pre-flight checks...\n");

    // 1. Check Telegram token
    const token = checkTelegramToken();
    if (!token) {
        process.exit(1);
    }

    // 2. Check ADB
    const adbOk = await checkAdb();
    if (!adbOk) {
        logError(
            "\nADB setup instructions:\n" +
            "1. Install Android SDK Platform-Tools\n" +
            "2. Enable USB Debugging on phone (Settings → Developer Options)\n" +
            "3. Connect phone via USB\n" +
            "4. Accept the USB debugging prompt on the phone\n" +
            '5. Run "adb devices" to verify\n',
        );
        process.exit(1);
    }

    // 3. Check LLM provider
    const llmOk = await checkLLM();
    if (!llmOk) {
        const provider = process.env.LLM_PROVIDER ?? "ollama";
        logError(
            `\nLLM setup instructions (provider: ${provider}):\n` +
            "  ollama  → Install from https://ollama.com, run: ollama serve && ollama pull qwen2.5\n" +
            "  gemini  → Set GEMINI_API_KEY in .env (get from aistudio.google.com)\n" +
            "  claude  → Set CLAUDE_API_KEY in .env (get from console.anthropic.com)\n" +
            "  grok    → Set GROK_API_KEY in .env (get from console.x.ai)\n",
        );
        process.exit(1);
    }

    // ── Initialize orchestrator ──
    logInfo("\nInitializing orchestrator...");
    const orchestrator = getOrchestrator();
    await orchestrator.initialize();

    // ── Start OAuth callback server (before bot so it's ready for callbacks) ──
    logInfo("\nStarting OAuth callback server...");
    getOAuthServer();

    // ── Start Telegram bot ──
    logInfo("\nStarting Telegram bot...");

    const allowedUsersStr = process.env.TELEGRAM_ALLOWED_USERS?.trim();
    const allowedUsers = allowedUsersStr
        ? allowedUsersStr.split(",").map((id) => Number(id.trim())).filter(Number.isFinite)
        : [];

    const bot = new PhoneAgentBot({
        token,
        allowedUsers,
    });

    await bot.start();

    // ── Start cron scheduler ──
    logInfo("\nStarting cron scheduler...");
    const scheduler = getCronScheduler();
    scheduler.setCallback(async (job) => {
        logInfo(`⏰ Cron executing: "${job.description}"`);
        try {
            const result = await orchestrator.executeTask(
                `[SCHEDULED TASK] ${job.task}`,
                {
                    onMessage: (msg) => bot.sendToDefaultChat?.(`🔔 Scheduled: ${job.description}\n\n${msg}`),
                },
            );
            // Send result to user
            bot.sendToDefaultChat?.(
                `⏰ **Scheduled task completed:** ${job.description}\n\n${result.message}`,
            );
        } catch (err) {
            logError(`Cron task failed: ${err instanceof Error ? err.message : err}`);
            bot.sendToDefaultChat?.(
                `❌ Scheduled task failed: ${job.description}\n\n${err instanceof Error ? err.message : String(err)}`,
            );
        }
    });
    scheduler.start();

    // ── Start self-healing heartbeat ──
    logInfo("\nStarting self-healing system...");
    const healer = getSelfHealer();
    healer.setCallbacks({
        onDisconnect: () => {
            bot.sendToDefaultChat?.("⚠️ Phone disconnected — attempting recovery...");
        },
        onReconnect: () => {
            bot.sendToDefaultChat?.("✅ Phone reconnected!");
        },
    });
    healer.startHeartbeat();

    // ── Start event monitor ──
    logInfo("\nStarting event monitor...");
    const eventMonitor = getEventMonitor();
    eventMonitor.setCallback(async (event, rule) => {
        logInfo(`🔔 Event rule fired: "${rule.name}" (${event.type} from ${event.source})`);
        try {
            const result = await orchestrator.executeTask(
                `[EVENT: ${event.type}] ${rule.action}`,
                {
                    onMessage: (msg) => bot.sendToDefaultChat?.(msg),
                },
            );
            bot.sendToDefaultChat?.(
                `🔔 **Event handled:** ${rule.name}\n\n${result.message}`,
            );
        } catch (err) {
            logError(`Event handler failed: ${err instanceof Error ? err.message : err}`);
            bot.sendToDefaultChat?.(
                `❌ Event handler failed: ${rule.name}\n${err instanceof Error ? err.message : String(err)}`,
            );
        }
    });
    eventMonitor.start();

    // ── Start goal agenda ──
    logInfo("\nStarting goal agenda...");
    const agenda = getAgendaManager();
    agenda.setCheckCallback(async (goal) => {
        const result = await orchestrator.executeTask(
            `[GOAL CHECK] Goal: "${goal.name}". ${goal.description}. Check if success criteria is met: ${goal.successCriteria}. ` +
            `Reply with COMPLETED if the goal is achieved, or PROGRESS if it's still in progress.`,
            {
                onMessage: (msg) => bot.sendToDefaultChat?.(`🎯 Goal check (${goal.name}): ${msg}`),
            },
        );
        const completed = result.message.toUpperCase().includes("COMPLETED");
        return { completed, message: result.message };
    });
    agenda.start();


    logInfo(`
╔═══════════════════════════════════════════╗
║       📱 Phone Agent v4.0.0 — FULL      ║
║  Multi-LLM + ADB + Google + Integrations ║
║                                           ║
║   ✅ Self-healing heartbeat active       ║
║   ✅ Event monitor active                ║
║   ✅ Goal agenda active                  ║
║   ✅ Cron scheduler active               ║
║   ✅ Google OAuth ready                  ║
║                                           ║
║   Send a message to your Telegram bot     ║
║   to start controlling your phone.        ║
║                                           ║
║   Press Ctrl+C to stop.                  ║
╚═══════════════════════════════════════════╝
  `);
}

// ─── Run ─────────────────────────────────────────────────────────────────────

main().catch((err) => {
    logError(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
    console.error(err);
    process.exit(1);
});
