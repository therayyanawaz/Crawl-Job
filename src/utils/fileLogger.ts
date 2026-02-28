/**
 * src/utils/fileLogger.ts
 *
 * Dual-output logging: writes every Crawlee log line to both stdout (normal)
 * AND to a dedicated `log.txt` file.
 *
 * BEHAVIOUR
 * ─────────
 *  • On initFileLogger(), the existing log.txt is TRUNCATED (overwritten) so
 *    every run starts with a clean file.
 *  • All subsequent log.info / log.warning / log.error calls are intercepted
 *    and their formatted text is appended to log.txt in real-time.
 *  • closeFileLogger() flushes and closes the write stream.
 */

import * as fs from 'fs';
import * as path from 'path';

const LOG_FILE = path.resolve(process.cwd(), 'log.txt');
const MAX_LOG_SIZE = 25 * 1024 * 1024; // 25 MB
const TARGET_SIZE = 20 * 1024 * 1024;  // Bring down to 20 MB when limit hit
const JSON_LOG_FILE = path.resolve(process.cwd(), 'log.json');

let writeStream: fs.WriteStream | null = null;
let originalStdoutWrite: typeof process.stdout.write | null = null;
let originalStderrWrite: typeof process.stderr.write | null = null;
let jsonWriteStream: fs.WriteStream | null = null;
let jsonRunId: string | null = null;
const isProdEnv = (): boolean => process.env.NODE_ENV === 'production';

let bytesSinceLastCheck = 0;
let isTruncating = false;

/**
 * Truncates the log file by keeping the last ~20MB of content.
 * Removes lines from the top to ensure we don't start with a partial line.
 */
function truncateLogFile(): void {
    if (isTruncating) return;
    isTruncating = true;

    try {
        if (!fs.existsSync(LOG_FILE)) return;
        const stats = fs.statSync(LOG_FILE);
        if (stats.size <= MAX_LOG_SIZE) return;

        // Close current stream
        if (writeStream) {
            writeStream.end();
            writeStream = null;
        }

        // Read the last TARGET_SIZE bytes
        // Node.js sync IO is used here as this is a background cleanup task
        const fd = fs.openSync(LOG_FILE, 'r');
        const buffer = Buffer.alloc(TARGET_SIZE);
        const position = Math.max(0, stats.size - TARGET_SIZE);
        const bytesRead = fs.readSync(fd, buffer, 0, TARGET_SIZE, position);
        fs.closeSync(fd);

        let content = buffer.toString('utf-8', 0, bytesRead);

        // Find the first newline to avoid a partial line at the top
        const firstNewLine = content.indexOf('\n');
        if (firstNewLine !== -1 && firstNewLine < content.length - 1) {
            content = content.slice(firstNewLine + 1);
        }

        // Overwrite the file with truncated content
        fs.writeFileSync(LOG_FILE, content, 'utf-8');

        // Restart the write stream
        writeStream = fs.createWriteStream(LOG_FILE, { flags: 'a', encoding: 'utf-8' });

        // Log the rotation event to the new file
        writeStream.write(`\n--- LOG ROTATED AT ${new Date().toISOString()} (Size was ${Math.round(stats.size / 1024 / 1024)}MB) ---\n`);
    } catch (err) {
        console.error(`[FileLogger] Rotation failed: ${err}`);
        // If everything fails, just reset the file to be safe
        try {
            fs.writeFileSync(LOG_FILE, `--- LOG RESET DUE TO ROTATION ERROR ${new Date().toISOString()} ---\n`, 'utf-8');
            if (!writeStream) {
                writeStream = fs.createWriteStream(LOG_FILE, { flags: 'a', encoding: 'utf-8' });
            }
        } catch { /* ignore */ }
    } finally {
        isTruncating = false;
        bytesSinceLastCheck = 0;
    }
}

/**
 * Initialise the file logger.
 * MUST be called ONCE at the very start of main(), before any log output.
 */
export function initFileLogger(): void {
    // Truncate the file (create if missing, empty if exists)
    fs.writeFileSync(LOG_FILE, '', 'utf-8');

    writeStream = fs.createWriteStream(LOG_FILE, { flags: 'a', encoding: 'utf-8' });

    // Intercept stdout so every console/log line also goes to the file
    originalStdoutWrite = process.stdout.write.bind(process.stdout);
    originalStderrWrite = process.stderr.write.bind(process.stderr);

    const hookedWrite = (chunk: any, encoding?: any, callback?: any): boolean => {
        const text = typeof chunk === 'string' ? chunk : chunk.toString();

        if (writeStream && !isTruncating) {
            writeStream.write(text);

            // Periodically check file size (every 1MB written)
            bytesSinceLastCheck += Buffer.byteLength(text);
            if (bytesSinceLastCheck > 1024 * 1024) {
                // Check stats
                try {
                    const stats = fs.statSync(LOG_FILE);
                    if (stats.size > MAX_LOG_SIZE) {
                        // Defer truncation to next tick to avoid blocking current write
                        setImmediate(() => truncateLogFile());
                    } else {
                        bytesSinceLastCheck = 0;
                    }
                } catch {
                    bytesSinceLastCheck = 0;
                }
            }
        }

        const original = (chunk === process.stdout ? originalStdoutWrite! :
            (chunk === process.stderr ? originalStderrWrite! :
                (originalStdoutWrite || originalStderrWrite)));

        // Use the correct original write function depending on the stream
        // Since we are replacing process.stdout.write and process.stderr.write separately:
        return false; // placeholder, see implementation below
    };

    process.stdout.write = (chunk: any, ...args: any[]): boolean => {
        const text = typeof chunk === 'string' ? chunk : chunk.toString();
        if (writeStream && !isTruncating) {
            writeStream.write(text);
            bytesSinceLastCheck += Buffer.byteLength(text);
            if (bytesSinceLastCheck > 1024 * 1024) {
                try {
                    const stats = fs.statSync(LOG_FILE);
                    if (stats.size > MAX_LOG_SIZE) setImmediate(() => truncateLogFile());
                    else bytesSinceLastCheck = 0;
                } catch { bytesSinceLastCheck = 0; }
            }
        }
        return (originalStdoutWrite as any)(chunk, ...args);
    };

    process.stderr.write = (chunk: any, ...args: any[]): boolean => {
        const text = typeof chunk === 'string' ? chunk : chunk.toString();
        if (writeStream && !isTruncating) {
            writeStream.write(text);
            bytesSinceLastCheck += Buffer.byteLength(text);
            if (bytesSinceLastCheck > 1024 * 1024) {
                try {
                    const stats = fs.statSync(LOG_FILE);
                    if (stats.size > MAX_LOG_SIZE) setImmediate(() => truncateLogFile());
                    else bytesSinceLastCheck = 0;
                } catch { bytesSinceLastCheck = 0; }
            }
        }
        return (originalStderrWrite as any)(chunk, ...args);
    };

    console.log(`[FileLogger] ✓ Logging to ${LOG_FILE} (Max size: 25MB)`);
}

export function initJsonLogger(runId: string): void {
    if (!isProdEnv()) return;
    jsonRunId = runId;
    fs.writeFileSync(JSON_LOG_FILE, '', 'utf-8');
    jsonWriteStream = fs.createWriteStream(JSON_LOG_FILE, { flags: 'a', encoding: 'utf-8' });
}

export function closeJsonLogger(): void {
    if (jsonWriteStream) {
        jsonWriteStream.end();
        jsonWriteStream = null;
    }
    jsonRunId = null;
}

export function logStructured(level: string, message: string, extra?: Record<string, unknown>): void {
    if (!isProdEnv() || !jsonWriteStream) return;
    const entry = {
        timestamp: new Date().toISOString(),
        level,
        message,
        runId: jsonRunId,
        ...extra,
    };
    jsonWriteStream.write(JSON.stringify(entry) + '\n');
}

/**
 * Flush and close the log file. Call in the finally/cleanup block.
 */
export function closeFileLogger(): void {
    if (writeStream) {
        writeStream.end();
        writeStream = null;
    }

    // Restore original stdout/stderr
    if (originalStdoutWrite) {
        process.stdout.write = originalStdoutWrite;
        originalStdoutWrite = null;
    }
    if (originalStderrWrite) {
        process.stderr.write = originalStderrWrite;
        originalStderrWrite = null;
    }
}
