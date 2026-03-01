/**
 * src/utils/alerts.ts
 *
 * Multi-channel alert dispatcher for crawl health events.
 *
 * SUPPORTED CHANNELS
 * ──────────────────
 * 1. Slack   — POST to ALERT_SLACK_WEBHOOK (Incoming Webhooks URL)
 * 2. Webhook — POST JSON payload to ALERT_WEBHOOK_URL (any HTTP endpoint)
 * 3. Email   — shell out to `sendmail` or `mail` (zero npm deps, works on
 *              any Linux server with an MTA installed such as postfix/ssmtp).
 *              For student servers: install ssmtp + Google SMTP config.
 *
 * ALERT STORM PREVENTION
 * ───────────────────────
 * Each (channel, severity) pair is rate-limited to one alert per
 * ALERT_COOLDOWN_MIN (default 15 min). This prevents a continuous failure
 * loop from sending hundreds of Slack messages at 2 AM.
 *
 * USAGE
 * ──────
 * import { sendAlert } from './alerts.js';
 * await sendAlert('critical', 'Crawler stopped producing jobs', { domain: 'linkedin.com' });
 */

import * as https from 'https';
import * as http from 'http';
import * as childProc from 'child_process';
import { log } from 'crawlee';
import type { HealthReport } from './healthCheck.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface AlertContext {
    [key: string]: string | number | boolean | undefined;
}

// ─── Config ───────────────────────────────────────────────────────────────────

const SLACK_WEBHOOK = process.env.ALERT_SLACK_WEBHOOK ?? '';
const GENERIC_WEBHOOK = process.env.ALERT_WEBHOOK_URL ?? '';
const ALERT_EMAIL = process.env.ALERT_EMAIL ?? '';
const COOLDOWN_MIN = Number(process.env.ALERT_COOLDOWN_MIN ?? 15);
const ALERTS_ENABLED = process.env.ENABLE_ALERTS !== 'false';

// ─── Rate Limiter ─────────────────────────────────────────────────────────────

/** key = `${channel}:${severity}` → last alert epoch ms */
const lastAlertSent = new Map<string, number>();

function isOnCooldown(channel: string, severity: AlertSeverity): boolean {
    const key = `${channel}:${severity}`;
    const last = lastAlertSent.get(key) ?? 0;
    return (Date.now() - last) < COOLDOWN_MIN * 60_000;
}

function markAlertSent(channel: string, severity: AlertSeverity): void {
    lastAlertSent.set(`${channel}:${severity}`, Date.now());
}

// ─── HTTP POST Helper ─────────────────────────────────────────────────────────

/** Performs a raw HTTPS/HTTP POST — no axios, no node-fetch dependency. */
function httpPost(url: string, body: string, contentType = 'application/json'): Promise<void> {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const isHttps = parsed.protocol === 'https:';
        const transport = isHttps ? https : http;
        const options = {
            hostname: parsed.hostname,
            port: parsed.port || (isHttps ? 443 : 80),
            path: parsed.pathname + parsed.search,
            method: 'POST',
            headers: {
                'Content-Type': contentType,
                'Content-Length': Buffer.byteLength(body),
            },
            timeout: 8000,
        };

        const req = transport.request(options, (res) => {
            res.resume(); // consume body
            if (res.statusCode && res.statusCode >= 400) {
                reject(new Error(`HTTP ${res.statusCode}`));
            } else {
                resolve();
            }
        });

        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
        req.write(body);
        req.end();
    });
}

// ─── Severity Formatting ──────────────────────────────────────────────────────

const SEVERITY_EMOJI: Record<AlertSeverity, string> = {
    info: 'ℹ️',
    warning: '⚠️',
    critical: '🚨',
};

function formatMessage(severity: AlertSeverity, message: string, ctx: AlertContext): string {
    const emoji = SEVERITY_EMOJI[severity];
    const ctxStr = Object.entries(ctx)
        .map(([k, v]) => `${k}=${v}`)
        .join(' | ');
    const ts = new Date().toISOString();
    return `${emoji} [CRAWL-JOB ${severity.toUpperCase()}] ${ts}\n${message}${ctxStr ? '\nContext: ' + ctxStr : ''}`;
}

// ─── Channel Senders ─────────────────────────────────────────────────────────

async function sendSlack(severity: AlertSeverity, message: string, ctx: AlertContext): Promise<void> {
    if (!SLACK_WEBHOOK) return;
    if (isOnCooldown('slack', severity)) {
        log.debug(`[Alerts] Slack on cooldown for ${severity}.`);
        return;
    }

    const color = severity === 'critical' ? '#FF0000' : severity === 'warning' ? '#FFA500' : '#36A64F';
    const payload = JSON.stringify({
        attachments: [{
            color,
            title: `Crawl-Job — ${severity.toUpperCase()}`,
            text: message,
            footer: Object.entries(ctx).map(([k, v]) => `${k}: ${v}`).join(' | '),
            ts: Math.floor(Date.now() / 1000),
        }],
    });

    try {
        await httpPost(SLACK_WEBHOOK, payload);
        markAlertSent('slack', severity);
        log.info(`[Alerts] Slack alert sent (${severity}).`);
    } catch (err: any) {
        log.warning(`[Alerts] Slack send failed: ${err.message}`);
    }
}

async function sendWebhook(severity: AlertSeverity, message: string, ctx: AlertContext): Promise<void> {
    if (!GENERIC_WEBHOOK) return;
    if (isOnCooldown('webhook', severity)) {
        log.debug(`[Alerts] Webhook on cooldown for ${severity}.`);
        return;
    }

    const payload = JSON.stringify({
        severity,
        message,
        context: ctx,
        timestamp: new Date().toISOString(),
        service: 'crawl-job',
    });

    try {
        await httpPost(GENERIC_WEBHOOK, payload);
        markAlertSent('webhook', severity);
        log.info(`[Alerts] Webhook alert sent (${severity}).`);
    } catch (err: any) {
        log.warning(`[Alerts] Webhook send failed: ${err.message}`);
    }
}

async function sendEmail(severity: AlertSeverity, message: string, ctx: AlertContext): Promise<void> {
    if (!ALERT_EMAIL) return;
    if (isOnCooldown('email', severity)) {
        log.debug(`[Alerts] Email on cooldown for ${severity}.`);
        return;
    }

    const subject = `[crawl-job] ${severity.toUpperCase()} Alert`;
    const body = formatMessage(severity, message, ctx);

    // Use `mail` command — available on most Linux servers (requires postfix/ssmtp/msmtp).
    // If not available, install: sudo apt install mailutils
    const cmd = `echo "${body.replace(/"/g, '\\"')}" | mail -s "${subject}" "${ALERT_EMAIL}"`;

    return new Promise((resolve) => {
        childProc.exec(cmd, { timeout: 10_000 }, (err) => {
            if (err) {
                log.warning(`[Alerts] Email send failed: ${err.message}`);
            } else {
                markAlertSent('email', severity);
                log.info(`[Alerts] Email alert sent to ${ALERT_EMAIL} (${severity}).`);
            }
            resolve(); // Never reject — alert failure must not crash the crawler
        });
    });
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Sends an alert to all configured channels concurrently.
 * Channels not configured (empty env vars) are silently skipped.
 * Never throws — alert failures are logged as warnings only.
 *
 * @param severity   'info' | 'warning' | 'critical'
 * @param message    Short human-readable description of the issue.
 * @param context    Key-value pairs with diagnostic data (domain, counts, etc.)
 */
export async function sendAlert(
    severity: AlertSeverity,
    message: string,
    context: AlertContext = {}
): Promise<void> {
    if (!ALERTS_ENABLED) {
        log.debug(`[Alerts] Alerts disabled. Would send (${severity}): ${message}`);
        return;
    }

    // Always log the alert to the crawler log regardless of channels
    const formatted = formatMessage(severity, message, context);
    if (severity === 'critical') log.error(formatted);
    else if (severity === 'warning') log.warning(formatted);
    else log.info(formatted);

    // Send to all channels concurrently
    await Promise.allSettled([
        sendSlack(severity, message, context),
        sendWebhook(severity, message, context),
        sendEmail(severity, message, context),
    ]);
}

/**
 * Convenience wrapper: sends a health report as an alert if the severity
 * warrants it. Pass the result of logHealthReport() directly.
 *
 * Mapping: critical → critical alert, degraded → warning alert, healthy → no alert.
 */
export async function alertOnHealthReport(report: HealthReport): Promise<void> {
    if (report.severity === 'healthy') return;

    const alertSeverity: AlertSeverity =
        report.severity === 'critical' ? 'critical' : 'warning';

    const ctx: AlertContext = {
        jobsExtracted: report.snapshot.jobsExtracted,
        successRate: `${report.snapshot.successRatePct}%`,
        rateLimitHits: report.snapshot.rateLimitHits,
        memoryMb: report.snapshot.currentMemoryMb,
        uptimeSec: report.snapshot.uptimeSeconds,
    };

    await sendAlert(alertSeverity, report.summary, ctx);
}

/**
 * Sends a startup notification to all configured channels.
 * Called once from main.ts after proxy pool is built.
 */
export async function sendStartupAlert(proxyCount: number): Promise<void> {
    await sendAlert('info', 'Crawl-Job started successfully.', {
        proxyCount,
        pid: process.pid,
        node: process.version,
    });
}

/**
 * Sends a completion notification when the crawler finishes normally.
 */
export async function sendCompletionAlert(jobsExtracted: number, durationSec: number): Promise<void> {
    await sendAlert('info', 'Crawl-Job run completed.', {
        jobsExtracted,
        durationSec,
        pid: process.pid,
    });
}
