import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { HeartbeatSender } from "./heartbeat";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";

const LOG_FILE = path.join(os.homedir(), '.wakatime', 'pi-wakatime.log');
const MAX_LOG_LINES = 5000;

function log(message: string) {
  const time = new Date().toISOString();
  try {
    fs.appendFileSync(LOG_FILE, `[${time}] [index] ${message}\n`);
  } catch (e) {}
}

function rotateLog() {
  try {
    if (!fs.existsSync(LOG_FILE)) return;
    
    const stats = fs.statSync(LOG_FILE);
    // Only rotate if file is larger than 500KB
    if (stats.size < 500 * 1024) return;
    
    const content = fs.readFileSync(LOG_FILE, 'utf-8');
    const lines = content.split('\n');
    
    if (lines.length > MAX_LOG_LINES) {
      const kept = lines.slice(-MAX_LOG_LINES).join('\n');
      fs.writeFileSync(LOG_FILE, kept);
    }
  } catch (e) {}
}

export default function (pi: ExtensionAPI) {
  rotateLog();
  const sender = new HeartbeatSender();
  let initialized = false;

  // Initialize CLI on session start or first activity
  const initPromise = sender.init().then(() => {
    initialized = true;
  }).catch(err => {
    log(`Failed to initialize: ${err}`);
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.isError) return;
    if (!initialized) await initPromise;

    // We only care about file operations
    if (!["read", "write", "edit"].includes(event.toolName)) return;

    // Use "any" cast for input as specific tool types are not strictly imported here
    // but we know the shape from the standard tools.
    const input = event.input as any;
    if (!input.path) return;

    const filePath = path.resolve(ctx.cwd, input.path);
    const projectRoot = ctx.cwd;

    if (event.toolName === "read") {
      sender.send(filePath, {
        projectRoot,
        isWrite: false,
        category: "ai coding" // Reading is coding context
      });
    } else if (event.toolName === "write") {
      const lineCount = (input.content || "").split('\n').length;
      sender.send(filePath, {
        projectRoot,
        isWrite: true,
        lineChanges: lineCount,
        category: "ai coding"
      });
    } else if (event.toolName === "edit") {
      const edits = Array.isArray(input.edits) ? input.edits : [];

      const lineChanges = edits.reduce((total: number, edit: any) => {
        const newText = edit?.newText || "";
        const oldText = edit?.oldText || "";
        const newLines = newText === "" ? 0 : newText.split('\n').length;
        const oldLines = oldText === "" ? 0 : oldText.split('\n').length;
        return total + Math.abs(newLines - oldLines);
      }, 0);
      
      sender.send(filePath, {
        projectRoot,
        isWrite: true,
        lineChanges,
        category: "ai coding"
      });
    }
  });

  // Intentionally do not send heartbeats on turn_start.
  // Reporting conversational turns with no file activity can look like
  // automated/AFK activity to WakaTime. Only actual file tool results above
  // are reported.
}
