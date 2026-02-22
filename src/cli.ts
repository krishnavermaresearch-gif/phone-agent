#!/usr/bin/env node

/**
 * CLI Test Mode — Run phone agent tasks directly from the command line.
 *
 * Usage:
 *   npx tsx src/cli.ts "open Settings"
 *   npx tsx src/cli.ts "take a screenshot"
 *   npx tsx src/cli.ts "what apps are installed?"
 */

import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { logError, logInfo, setLogLevel } from "./logger.js";
import { getLLMProvider } from "./llm/provider-factory.js";
import { getOrchestrator } from "./agent/orchestrator.js";

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
        // Ignore
    }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    loadEnv();

    if (process.env.LOG_LEVEL) {
        setLogLevel(process.env.LOG_LEVEL as any);
    }

    const task = process.argv.slice(2).join(" ").trim();
    if (!task) {
        console.log(`
📱 Phone Agent — CLI Test Mode

Usage:
  npx tsx src/cli.ts "your task here"

Examples:
  npx tsx src/cli.ts "take a screenshot"
  npx tsx src/cli.ts "open Settings"
  npx tsx src/cli.ts "what's on the screen?"
  npx tsx src/cli.ts "open YouTube and search for cats"
  npx tsx src/cli.ts "list installed apps"
`);
        process.exit(0);
    }

    console.log(`\n📱 Phone Agent CLI — Task: "${task}"\n`);

    // Check LLM
    const llm = getLLMProvider();
    const health = await llm.healthCheck();
    if (!health.ok) {
        logError(`${llm.name}: ${health.error}`);
        process.exit(1);
    }
    logInfo(`✅ ${llm.name}: ${llm.getModel()}`);

    // Initialize orchestrator
    const orch = getOrchestrator();
    await orch.initialize();

    logInfo(`✅ Device connected, ${orch.getToolNames().length} tools loaded`);
    console.log(`\n${"─".repeat(60)}`);
    console.log(`🚀 Executing: "${task}"`);
    console.log(`${"─".repeat(60)}\n`);

    let screenshotCount = 0;

    // Execute task
    const result = await orch.executeTask(task, {
        onToolResult: (toolName, toolResult) => {
            // Show tool results in console
            if (toolName === "adb_screenshot" && toolResult.buffer) {
                screenshotCount++;
                const filename = `test_screenshot_${screenshotCount}.png`;
                writeFileSync(filename, toolResult.buffer);
                console.log(`  📸 Screenshot saved: ${filename}`);
            } else {
                const preview = toolResult.content.slice(0, 200);
                console.log(`  🔧 ${toolName}: ${preview}`);
            }
        },
        onMessage: (text) => {
            console.log(`\n💬 Agent: ${text}`);
        },
    });

    // Final output
    console.log(`\n${"─".repeat(60)}`);
    console.log(`${result.success ? "✅ SUCCESS" : "⚠️ INCOMPLETE"}`);
    console.log(`📊 Tool calls: ${result.totalToolCalls}`);
    console.log(`${"─".repeat(60)}`);
    console.log(`\n${result.message}\n`);

    if (result.lastScreenshot) {
        writeFileSync("test_final_screenshot.png", result.lastScreenshot);
        console.log("📸 Final screenshot saved: test_final_screenshot.png\n");
    }
}

main().catch((err) => {
    logError(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
});
