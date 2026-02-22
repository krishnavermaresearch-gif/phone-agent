import { Telegraf, type Context } from "telegraf";
import { logError, logInfo, logWarn } from "../logger.js";
import { getOrchestrator } from "../agent/orchestrator.js";
// ADB connection accessed via orchestrator
import { formatDeviceInfo, getDeviceInfo } from "../adb/device-info.js";
import { captureScreenshotBuffer } from "../tools/screenshot.js";
import type { ToolResult } from "../agent/tool-registry.js";

// ─── Types ───────────────────────────────────────────────────────────────────

type BotConfig = {
    token: string;
    /** Only allow these Telegram user IDs (security). Empty = allow all. */
    allowedUsers?: number[];
};

// ─── Bot ─────────────────────────────────────────────────────────────────────

/**
 * Telegram bot — the user interface for the phone agent.
 * Handles commands, routes text messages to the orchestrator,
 * and sends screenshots/results back to the user.
 */
export class PhoneAgentBot {
    private bot: Telegraf;
    private allowedUsers: Set<number>;
    private activeTasks = new Set<number>(); // chat IDs with running tasks
    private defaultChatId: number | null = null; // last active chat for cron delivery

    constructor(config: BotConfig) {
        this.bot = new Telegraf(config.token, {
            handlerTimeout: 300_000, // 5 minutes — complex tasks can take a while
        });
        this.allowedUsers = new Set(config.allowedUsers ?? []);

        this.setupHandlers();
    }

    // ── Handlers ─────────────────────────────────────────────────────────────

    private setupHandlers(): void {
        // Middleware: auth check
        this.bot.use(async (ctx, next) => {
            if (this.allowedUsers.size > 0 && ctx.from) {
                if (!this.allowedUsers.has(ctx.from.id)) {
                    await ctx.reply("⛔ Unauthorized. Your Telegram user ID is not in the allowlist.");
                    logWarn(`Unauthorized access attempt from user ${ctx.from.id} (${ctx.from.username})`);
                    return;
                }
            }
            return next();
        });

        // /start — welcome + device info
        this.bot.start(async (ctx) => {
            try {
                const info = await getDeviceInfo();
                const orch = getOrchestrator();

                await ctx.reply(
                    `📱 *Phone Agent Ready!*\n\n` +
                    `\`\`\`\n${formatDeviceInfo(info)}\n\`\`\`\n\n` +
                    `🔌 *Plugins:* ${orch.getPluginNames().join(", ") || "loading..."}\n\n` +
                    `Send me any task and I'll execute it on your phone!\n\n` +
                    `*Commands:*\n` +
                    `/screenshot — Take a screenshot\n` +
                    `/status — Device status\n` +
                    `/plugins — List plugins\n` +
                    `/help — Show help`,
                    { parse_mode: "Markdown" },
                );
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                await ctx.reply(`❌ Error getting device info: ${msg}`);
            }
        });

        // /screenshot — take and send a screenshot
        this.bot.command("screenshot", async (ctx) => {
            try {
                await ctx.sendChatAction("upload_photo");
                const buffer = await captureScreenshotBuffer(1080);
                await ctx.replyWithPhoto({ source: buffer }, { caption: "📸 Current screen" });
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                await ctx.reply(`❌ Screenshot failed: ${msg}`);
            }
        });

        // /status — device status
        this.bot.command("status", async (ctx) => {
            try {
                const info = await getDeviceInfo();
                await ctx.reply(
                    `📊 *Device Status*\n\`\`\`\n${formatDeviceInfo(info)}\n\`\`\``,
                    { parse_mode: "Markdown" },
                );
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                await ctx.reply(`❌ Status failed: ${msg}`);
            }
        });

        // /plugins — list loaded plugins
        this.bot.command("plugins", async (ctx) => {
            const orch = getOrchestrator();
            const plugins = orch.getPluginNames();
            const tools = orch.getToolNames();

            await ctx.reply(
                `🔌 *Plugins:*\n${plugins.map((p) => `• ${p}`).join("\n") || "None loaded"}\n\n` +
                `🔧 *Tools (${tools.length}):*\n${tools.map((t) => `\`${t}\``).join(", ")}`,
                { parse_mode: "Markdown" },
            );
        });

        // /addapi <name> <key> [baseUrl] — add an API key
        this.bot.command("addapi", async (ctx) => {
            const { getApiManager } = await import("../api/api-manager.js");
            const args = (ctx.message?.text ?? "").split(/\s+/).slice(1);

            if (args.length < 2) {
                await ctx.reply(
                    "📝 *Usage:* `/addapi <service_name> <api_key> [base_url]`\n\n" +
                    "*Examples:*\n" +
                    "• `/addapi openweather abc123`\n" +
                    "• `/addapi spotify xyz789 https://api.spotify.com`",
                    { parse_mode: "Markdown" },
                );
                return;
            }

            const [name, key, ...rest] = args;
            const baseUrl = rest.length > 0 ? rest.join(" ") : undefined;
            getApiManager().addApi(name!, key!, baseUrl);

            // Auto-generate tool for this API immediately
            let toolMsg = "";
            try {
                const { refreshApiTools } = await import("../api/auto-tool-generator.js");
                const orch = getOrchestrator();
                const registry = orch.getRegistry();
                if (registry) {
                    refreshApiTools(registry);
                    toolMsg = `\n🔧 Tool \`api_${name!.toLowerCase()}\` auto-created — I can now use this API directly!`;
                }
            } catch {
                // Best-effort
            }

            await ctx.reply(
                `✅ API \`${name}\` added successfully!${toolMsg}`,
                { parse_mode: "Markdown" },
            );
        });

        // /removeapi <name> — remove an API
        this.bot.command("removeapi", async (ctx) => {
            const { getApiManager } = await import("../api/api-manager.js");
            const name = (ctx.message?.text ?? "").split(/\s+/)[1];

            if (!name) {
                await ctx.reply("📝 *Usage:* `/removeapi <service_name>`", { parse_mode: "Markdown" });
                return;
            }

            const removed = getApiManager().removeApi(name);
            await ctx.reply(
                removed ? `🗑 API \`${name}\` removed.` : `❓ API \`${name}\` not found.`,
                { parse_mode: "Markdown" },
            );
        });

        // /listapis — show all configured APIs
        this.bot.command("listapis", async (ctx) => {
            const { getApiManager } = await import("../api/api-manager.js");
            const apis = getApiManager().listApis();

            if (apis.length === 0) {
                await ctx.reply("📭 No APIs configured. Use `/addapi` to add one.", { parse_mode: "Markdown" });
            } else {
                await ctx.reply(
                    `🔑 *Configured APIs (${apis.length}):*\n${apis.map((a) => `• \`${a}\``).join("\n")}`,
                    { parse_mode: "Markdown" },
                );
            }
        });

        // /skills — show auto-learned app skills
        this.bot.command("skills", async (ctx) => {
            const { getSkillGenerator } = await import("../learning/skill-generator.js");
            const apps = getSkillGenerator().getKnownApps();

            if (apps.length === 0) {
                await ctx.reply("🧠 No skills learned yet. Use me more and I'll get smarter!");
            } else {
                await ctx.reply(
                    `🧠 *Learned Skills:*\n${apps.map((a) => `• ${a}`).join("\n")}`,
                    { parse_mode: "Markdown" },
                );
            }
        });

        // /feedback <good|bad> — explicit user feedback for RL
        this.bot.command("feedback", async (ctx) => {
            const arg = (ctx.message?.text ?? "").split(/\s+/)[1]?.toLowerCase();

            if (!arg || !["good", "bad", "👍", "👎"].includes(arg)) {
                await ctx.reply(
                    "📝 *Usage:* `/feedback good` or `/feedback bad`\n" +
                    "This helps me learn from my last action!",
                    { parse_mode: "Markdown" },
                );
                return;
            }

            const isPositive = arg === "good" || arg === "👍";
            // The reward tracker will pick this up from the next interaction context
            await ctx.reply(isPositive ? "👍 Thanks! I'll keep doing that." : "👎 Got it, I'll try differently next time.");
        });

        // /help
        this.bot.command("help", async (ctx) => {
            await ctx.reply(
                `📱 *Phone Agent Help*\n\n` +
                `Just send me any task in natural language!\n\n` +
                `*Examples:*\n` +
                `• \"Open YouTube and search for cats\"\n` +
                `• \"Take a screenshot\"\n` +
                `• \"What apps are installed?\"\n` +
                `• \"Open WhatsApp and read my recent messages\"\n` +
                `• \"Open Settings and check battery\"\n` +
                `• \"Send a WhatsApp message to Mom saying I'll be late\"\n\n` +
                `*Commands:*\n` +
                `/screenshot — Quick screenshot\n` +
                `/status — Device info\n` +
                `/plugins — Available plugins\n` +
                `/skills — Learned app skills\n` +
                `/addapi — Add an API key\n` +
                `/listapis — Show configured APIs\n` +
                `/removeapi — Remove an API\n` +
                `/feedback — Rate my last action\n` +
                `/stop — Cancel current task`,
                { parse_mode: "Markdown" },
            );
        });

        // /stop — cancel current task
        this.bot.command("stop", async (ctx) => {
            const chatId = ctx.chat.id;
            if (this.activeTasks.has(chatId)) {
                this.activeTasks.delete(chatId);
                await ctx.reply("⏹ Task cancelled.");
            } else {
                await ctx.reply("No task is currently running.");
            }
        });

        // Text messages — execute phone tasks
        this.bot.on("text", async (ctx) => {
            const chatId = ctx.chat.id;
            const text = ctx.message.text.trim();

            if (!text || text.startsWith("/")) return;

            // Check if already running a task
            if (this.activeTasks.has(chatId)) {
                await ctx.reply("⏳ A task is already running. Send /stop to cancel it first.");
                return;
            }

            this.activeTasks.add(chatId);
            this.defaultChatId = chatId; // track for cron delivery
            logInfo(`Task from user ${ctx.from.id}: "${text}"`);

            try {
                // Show typing indicator
                await ctx.sendChatAction("typing");

                // Send initial acknowledgment
                await ctx.reply(`🤖 Working on: "${text.slice(0, 100)}"\n⏳ Processing...`);

                let lastScreenshotSent = 0;
                const MIN_SCREENSHOT_INTERVAL = 5000; // Don't spam screenshots

                // Typing keepalive — prevents Telegram from timing out
                const typingTimer = setInterval(async () => {
                    try { await ctx.sendChatAction("typing"); } catch { /* ignore */ }
                }, 4000);

                // Execute task via orchestrator
                const orch = getOrchestrator();
                let result;
                try {
                    result = await orch.executeTask(text, {
                        chatId: chatId,
                        onToolResult: async (toolName: string, toolResult: ToolResult) => {
                            // Send screenshots as progress updates
                            if (
                                toolResult.buffer &&
                                toolName === "adb_screenshot" &&
                                Date.now() - lastScreenshotSent > MIN_SCREENSHOT_INTERVAL
                            ) {
                                try {
                                    await ctx.replyWithPhoto(
                                        { source: toolResult.buffer },
                                        { caption: `📸 Progress screenshot` },
                                    );
                                    lastScreenshotSent = Date.now();
                                } catch {
                                    // Ignore photo send failures during progress
                                }
                            }
                        },
                    });
                } finally {
                    clearInterval(typingTimer);
                }

                // Send final result
                const message = result.message.slice(0, 4000);
                if (result.lastScreenshot) {
                    await ctx.replyWithPhoto(
                        { source: result.lastScreenshot },
                        {
                            caption:
                                `${result.success ? "✅" : "⚠️"} ${message.slice(0, 1000)}\n\n` +
                                `📊 ${result.totalToolCalls} actions performed`,
                        },
                    );
                    // If message was longer than photo caption allows, send the rest
                    if (message.length > 1000) {
                        await ctx.reply(message.slice(1000));
                    }
                } else {
                    // Split long messages (Telegram limit ~4096 chars)
                    const fullMsg = `${result.success ? "✅" : "⚠️"} ${message}\n\n📊 ${result.totalToolCalls} actions performed`;
                    if (fullMsg.length > 4000) {
                        const parts = splitMessage(fullMsg, 4000);
                        for (const part of parts) {
                            await ctx.reply(part);
                        }
                    } else {
                        await ctx.reply(fullMsg);
                    }
                }
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                logError(`Task failed: ${msg}`);
                await ctx.reply(`❌ Task failed: ${msg}`);
            } finally {
                this.activeTasks.delete(chatId);
            }
        });

        // ── Multi-Modal Handlers ─────────────────────────────────────────────

        // Photos — download, save, and analyze
        this.bot.on("photo", async (ctx) => {
            const chatId = ctx.chat.id;
            if (this.activeTasks.has(chatId)) {
                await ctx.reply("⏳ A task is already running. Send /stop to cancel it first.");
                return;
            }

            this.activeTasks.add(chatId);
            this.defaultChatId = chatId;
            const caption = ctx.message.caption || "Analyze this image";

            try {
                await ctx.sendChatAction("typing");
                await ctx.reply(`🖼️ Image received! Working on: "${caption.slice(0, 80)}"\n⏳ Processing...`);

                // Get the highest resolution photo
                const photos = ctx.message.photo;
                const bestPhoto = photos[photos.length - 1]!;
                const fileLink = await ctx.telegram.getFileLink(bestPhoto.file_id);

                // Download the image
                const { writeFileSync, mkdirSync, existsSync } = await import("node:fs");
                const { resolve } = await import("node:path");
                const mediaDir = resolve(process.cwd(), "data", "telegram-media");
                if (!existsSync(mediaDir)) mkdirSync(mediaDir, { recursive: true });

                const imgPath = resolve(mediaDir, `photo_${Date.now()}.jpg`);
                const imgRes = await fetch(fileLink.href);
                const imgBuffer = Buffer.from(await imgRes.arrayBuffer());
                writeFileSync(imgPath, imgBuffer);

                logInfo(`📸 Photo saved: ${imgPath} (${(imgBuffer.length / 1024).toFixed(1)} KB)`);

                // Convert image to base64 for LLM vision
                const imgBase64 = imgBuffer.toString("base64");

                // Send to orchestrator with image directly in the message
                const orch = getOrchestrator();
                const taskMsg = `The user sent an image with caption: "${caption}". ` +
                    `The image is attached — you can see it directly. ` +
                    `It is also saved at ${imgPath} if you need to process it further. ` +
                    `Analyze the image and respond to the user's request.`;

                const typingTimer = setInterval(async () => {
                    try { await ctx.sendChatAction("typing"); } catch { /* ignore */ }
                }, 4000);

                let result;
                try {
                    result = await orch.executeTask(taskMsg, { chatId, images: [imgBase64] });
                } finally {
                    clearInterval(typingTimer);
                }

                const fullMsg = `${result.success ? "✅" : "⚠️"} ${result.message.slice(0, 4000)}\n\n📊 ${result.totalToolCalls} actions performed`;
                for (const part of splitMessage(fullMsg, 4000)) {
                    await ctx.reply(part);
                }
            } catch (err) {
                await ctx.reply(`❌ Failed to process image: ${err instanceof Error ? err.message : err}`);
            } finally {
                this.activeTasks.delete(chatId);
            }
        });

        // Voice messages — download and transcribe
        this.bot.on("voice", async (ctx) => {
            const chatId = ctx.chat.id;
            if (this.activeTasks.has(chatId)) {
                await ctx.reply("⏳ A task is already running. Send /stop to cancel it first.");
                return;
            }

            this.activeTasks.add(chatId);
            this.defaultChatId = chatId;

            try {
                await ctx.sendChatAction("typing");
                await ctx.reply("🎤 Voice message received!\n⏳ Processing...");

                const voice = ctx.message.voice;
                const fileLink = await ctx.telegram.getFileLink(voice.file_id);

                // Download voice file
                const { writeFileSync, mkdirSync, existsSync } = await import("node:fs");
                const { resolve } = await import("node:path");
                const mediaDir = resolve(process.cwd(), "data", "telegram-media");
                if (!existsSync(mediaDir)) mkdirSync(mediaDir, { recursive: true });

                const voicePath = resolve(mediaDir, `voice_${Date.now()}.ogg`);
                const voiceRes = await fetch(fileLink.href);
                const voiceBuffer = Buffer.from(await voiceRes.arrayBuffer());
                writeFileSync(voicePath, voiceBuffer);

                logInfo(`🎤 Voice saved: ${voicePath} (${(voiceBuffer.length / 1024).toFixed(1)} KB, ${voice.duration}s)`);

                // Send to orchestrator — agent can use execute_code to transcribe
                const orch = getOrchestrator();
                const taskMsg = `The user sent a voice message (saved at ${voicePath}, duration: ${voice.duration}s, format: OGG). ` +
                    `Try to understand what the user wants. If you can use execute_code with Python to transcribe it (using speech_recognition or whisper), do so. ` +
                    `Otherwise, acknowledge the voice message and ask what they need help with.`;

                const typingTimer = setInterval(async () => {
                    try { await ctx.sendChatAction("typing"); } catch { /* ignore */ }
                }, 4000);

                let result;
                try {
                    result = await orch.executeTask(taskMsg, { chatId });
                } finally {
                    clearInterval(typingTimer);
                }

                const fullMsg = `${result.success ? "✅" : "⚠️"} ${result.message.slice(0, 4000)}\n\n📊 ${result.totalToolCalls} actions performed`;
                for (const part of splitMessage(fullMsg, 4000)) {
                    await ctx.reply(part);
                }
            } catch (err) {
                await ctx.reply(`❌ Failed to process voice: ${err instanceof Error ? err.message : err}`);
            } finally {
                this.activeTasks.delete(chatId);
            }
        });

        // Documents/Files — download and process
        this.bot.on("document", async (ctx) => {
            const chatId = ctx.chat.id;
            if (this.activeTasks.has(chatId)) {
                await ctx.reply("⏳ A task is already running. Send /stop to cancel it first.");
                return;
            }

            this.activeTasks.add(chatId);
            this.defaultChatId = chatId;
            const caption = ctx.message.caption || "";
            const doc = ctx.message.document;

            try {
                await ctx.sendChatAction("typing");
                await ctx.reply(`📄 File received: "${doc.file_name}"\n⏳ Processing...`);

                const fileLink = await ctx.telegram.getFileLink(doc.file_id);

                // Download file
                const { writeFileSync, mkdirSync, existsSync } = await import("node:fs");
                const { resolve } = await import("node:path");
                const mediaDir = resolve(process.cwd(), "data", "telegram-media");
                if (!existsSync(mediaDir)) mkdirSync(mediaDir, { recursive: true });

                const filePath = resolve(mediaDir, doc.file_name ?? `file_${Date.now()}`);
                const fileRes = await fetch(fileLink.href);
                const fileBuffer = Buffer.from(await fileRes.arrayBuffer());
                writeFileSync(filePath, fileBuffer);

                logInfo(`📄 File saved: ${filePath} (${(fileBuffer.length / 1024).toFixed(1)} KB)`);

                // Send to orchestrator
                const orch = getOrchestrator();
                const taskMsg = `The user sent a file: "${doc.file_name}" (${(doc.file_size! / 1024).toFixed(1)} KB, type: ${doc.mime_type || "unknown"}). ` +
                    `It is saved at: ${filePath}. ` +
                    (caption ? `User's message: "${caption}". ` : "") +
                    `Use read_file to read its contents (or execute_code for binary/PDF files), then help the user with whatever they need. ` +
                    `If no specific request was made, summarize the file contents.`;

                const typingTimer = setInterval(async () => {
                    try { await ctx.sendChatAction("typing"); } catch { /* ignore */ }
                }, 4000);

                let result;
                try {
                    result = await orch.executeTask(taskMsg, { chatId });
                } finally {
                    clearInterval(typingTimer);
                }

                const fullMsg = `${result.success ? "✅" : "⚠️"} ${result.message.slice(0, 4000)}\n\n📊 ${result.totalToolCalls} actions performed`;
                for (const part of splitMessage(fullMsg, 4000)) {
                    await ctx.reply(part);
                }
            } catch (err) {
                await ctx.reply(`❌ Failed to process file: ${err instanceof Error ? err.message : err}`);
            } finally {
                this.activeTasks.delete(chatId);
            }
        });

        // Stickers, video, audio — acknowledge and save
        this.bot.on(["video", "animation", "audio", "sticker", "video_note"], async (ctx) => {
            const chatId = ctx.chat.id;
            this.defaultChatId = chatId;
            const mediaType = "video" in ctx.message ? "video" :
                "animation" in ctx.message ? "GIF" :
                    "audio" in ctx.message ? "audio" :
                        "sticker" in ctx.message ? "sticker" : "video note";
            await ctx.reply(`📎 ${mediaType} received! I can process images, documents, voice messages, and text. For ${mediaType}s, please describe what you'd like me to do with it.`);
        });

        // Error handling
        this.bot.catch((err: unknown, _ctx: Context) => {
            const msg = err instanceof Error ? err.message : String(err);
            logError(`Bot error: ${msg}`);
        });
    }

    /**
     * Send a message to the most recently active chat.
     * Used by the cron scheduler to deliver proactive messages.
     */
    async sendToDefaultChat(text: string): Promise<void> {
        if (!this.defaultChatId) {
            logWarn("No default chat ID — cannot send cron message");
            return;
        }
        try {
            const chunks = splitMessage(text, 4000);
            for (const chunk of chunks) {
                await this.bot.telegram.sendMessage(this.defaultChatId, chunk);
            }
        } catch (err) {
            logError(`Failed to send to default chat: ${err instanceof Error ? err.message : err}`);
        }
    }

    // ── Lifecycle ────────────────────────────────────────────────────────────

    async start(): Promise<void> {
        logInfo("Starting Telegram bot...");

        // Start polling
        await this.bot.launch();
        logInfo("✅ Telegram bot is running! Send a message to your bot to start.");

        // Graceful shutdown
        const shutdown = () => {
            logInfo("Shutting down bot...");
            this.bot.stop("SIGINT");
        };
        process.once("SIGINT", shutdown);
        process.once("SIGTERM", shutdown);
    }

    async stop(): Promise<void> {
        this.bot.stop("shutdown");
    }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Split a long message into chunks that fit Telegram's ~4096 char limit. */
function splitMessage(text: string, maxLen: number): string[] {
    const parts: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
        if (remaining.length <= maxLen) {
            parts.push(remaining);
            break;
        }
        // Try to split at newline
        let splitAt = remaining.lastIndexOf("\n", maxLen);
        if (splitAt < maxLen / 2) splitAt = maxLen;
        parts.push(remaining.slice(0, splitAt));
        remaining = remaining.slice(splitAt).trimStart();
    }
    return parts;
}
