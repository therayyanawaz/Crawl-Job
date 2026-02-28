/**
 * src/utils/cloudUpload.ts
 *
 * OPTIONAL — Only used when CLOUD_UPLOAD_ENABLED=true.
 *
 * Uploads archived .tar.gz files to any S3-compatible object store
 * using ONLY Node.js built-ins (https, crypto, fs).
 *
 * NO aws-sdk DEPENDENCY — implements AWS Signature Version 4 manually.
 * This keeps the package.json lean. For production workloads with many
 * concurrent uploads, consider adding @aws-sdk/client-s3.
 *
 * SUPPORTED BACKENDS
 * ──────────────────
 *  • AWS S3:              S3_ENDPOINT=          (leave blank — auto-detected)
 *  • DigitalOcean Spaces: S3_ENDPOINT=https://sgp1.digitaloceanspaces.com
 *  • MinIO (self-hosted): S3_ENDPOINT=http://your-minio-server:9000
 *  • Cloudflare R2:       S3_ENDPOINT=https://<accountid>.r2.cloudflarestorage.com
 *
 * WHY MANUAL SigV4?
 * ─────────────────
 * The aws-sdk v3 adds ~40 MB to node_modules (after tree-shaking ~3–5 MB).
 * For a student project that uploads weekly, the overhead isn't worth it.
 * SigV4 for a single PUT request is ~60 lines of crypto code — tractable.
 *
 * USAGE
 * ──────
 *   import { uploadArchive, uploadAllPendingArchives } from './utils/cloudUpload';
 *
 *   // Upload one file:
 *   await uploadArchive('/opt/job-crawler/storage/archives/2026/02/2026-02-14_jobs_001-010.tar.gz');
 *
 *   // Upload everything not yet uploaded:
 *   await uploadAllPendingArchives();
 */

import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';
import * as crypto from 'crypto';
import { log } from 'crawlee';
import type { ArchiveManifest } from './archive';
import 'dotenv/config';

// ─── Config ───────────────────────────────────────────────────────────────────

const ENABLED = process.env.CLOUD_UPLOAD_ENABLED === 'true';
const S3_BUCKET = process.env.S3_BUCKET ?? '';
const S3_REGION = process.env.S3_REGION ?? 'ap-south-1'; // Mumbai — closest to India
const ACCESS_KEY = process.env.S3_ACCESS_KEY ?? '';
const SECRET_KEY = process.env.S3_SECRET_KEY ?? '';
const ENDPOINT = process.env.S3_ENDPOINT ?? ''; // blank = AWS S3

const STORAGE_DIR = process.env.CRAWLEE_STORAGE_DIR ?? path.join(process.cwd(), 'storage');
const ARCHIVES_ROOT = path.join(STORAGE_DIR, 'archives');

// ─── SigV4 Implementation ─────────────────────────────────────────────────────

function hmac(key: Buffer | string, data: string): Buffer {
    return crypto.createHmac('sha256', key).update(data).digest();
}

function sha256hex(data: string | Buffer): string {
    return crypto.createHash('sha256').update(data).digest('hex');
}

function buildSigningKey(secretKey: string, dateStamp: string, region: string, service: string): Buffer {
    const kDate = hmac(`AWS4${secretKey}`, dateStamp);
    const kRegion = hmac(kDate, region);
    const kService = hmac(kRegion, service);
    return hmac(kService, 'aws4_request');
}

function pad2(n: number): string { return n.toString().padStart(2, '0'); }

function isoDate(d: Date): string {
    return `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}`;
}

function isoDateTime(d: Date): string {
    return `${isoDate(d)}T${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}Z`;
}

/**
 * Builds a presigned PUT URL and signed headers for a single S3 object upload.
 * Returns the {url, headers} needed to call https.request directly.
 */
function buildPutHeaders(
    bucket: string,
    objectKey: string,
    region: string,
    endpoint: string,
    accessKey: string,
    secretKey: string,
    fileBuffer: Buffer
): { url: string; headers: Record<string, string> } {
    const now = new Date();
    const dateStamp = isoDate(now);
    const dateTimeStamp = isoDateTime(now);

    const host = endpoint
        ? new URL(endpoint).host
        : `${bucket}.s3.${region}.amazonaws.com`;

    const url = endpoint
        ? `${endpoint}/${bucket}/${objectKey}`
        : `https://${bucket}.s3.${region}.amazonaws.com/${objectKey}`;

    const payloadHash = sha256hex(fileBuffer);

    const headers: Record<string, string> = {
        'Host': host,
        'Content-Type': 'application/gzip',
        'Content-Length': String(fileBuffer.length),
        'x-amz-date': dateTimeStamp,
        'x-amz-content-sha256': payloadHash,
        'x-amz-storage-class': 'STANDARD_IA',  // Infrequent Access — cheaper for cold archives
    };

    // Canonical headers (sorted alphabetically by header name, lowercase)
    const sortedHeaderNames = Object.keys(headers).map((h) => h.toLowerCase()).sort();
    const canonicalHeaders = sortedHeaderNames
        .map((h) => `${h}:${headers[Object.keys(headers).find((k) => k.toLowerCase() === h)!]}\n`)
        .join('');
    const signedHeaders = sortedHeaderNames.join(';');

    const canonicalRequest = [
        'PUT',
        `/${objectKey}`,
        '',   // no query string
        canonicalHeaders,
        signedHeaders,
        payloadHash,
    ].join('\n');

    const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
    const stringToSign = [
        'AWS4-HMAC-SHA256',
        dateTimeStamp,
        credentialScope,
        sha256hex(canonicalRequest),
    ].join('\n');

    const signingKey = buildSigningKey(secretKey, dateStamp, region, 's3');
    const signature = hmac(signingKey, stringToSign).toString('hex');

    const authHeader = [
        `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}`,
        `SignedHeaders=${signedHeaders}`,
        `Signature=${signature}`,
    ].join(', ');

    return {
        url,
        headers: { ...headers, 'Authorization': authHeader },
    };
}

// ─── HTTP PUT helper ──────────────────────────────────────────────────────────

function httpPut(url: string, headers: Record<string, string>, body: Buffer): Promise<number> {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const isHttps = parsed.protocol === 'https:';
        const transport = isHttps ? https : http;

        const opts = {
            hostname: parsed.hostname,
            port: parsed.port || (isHttps ? 443 : 80),
            path: parsed.pathname + parsed.search,
            method: 'PUT',
            headers,
            timeout: 120_000, // 2 min — large archives on slow connections
        };

        const req = transport.request(opts, (res) => {
            let data = '';
            res.on('data', (c) => data += c);
            res.on('end', () => {
                if (res.statusCode && res.statusCode < 300) {
                    resolve(res.statusCode!);
                } else {
                    reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
                }
            });
        });

        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Upload timed out')); });
        req.write(body);
        req.end();
    });
}

// ─── Main Exports ──────────────────────────────────────────────────────────────

/**
 * Uploads a single .tar.gz archive to the configured S3-compatible bucket.
 *
 * The object key mirrors the archive's local path structure:
 *   archives/2026/02/2026-02-14_jobs_001-010.tar.gz
 *
 * On success, writes `uploadedAt` into the companion manifest — this is
 * what cleanup.ts checks before allowing local deletion.
 */
export async function uploadArchive(archivePath: string): Promise<boolean> {
    if (!ENABLED) {
        log.debug('[CloudUpload] Cloud upload disabled. Skipping.');
        return false;
    }

    if (!S3_BUCKET || !ACCESS_KEY || !SECRET_KEY) {
        log.warning('[CloudUpload] S3_BUCKET, S3_ACCESS_KEY, or S3_SECRET_KEY not set in .env. Skipping upload.');
        return false;
    }

    if (!fs.existsSync(archivePath)) {
        log.error(`[CloudUpload] Archive not found: ${archivePath}`);
        return false;
    }

    const fileBuffer = fs.readFileSync(archivePath);
    const objectKey = path.relative(STORAGE_DIR, archivePath).replace(/\\/g, '/');
    const relPath = path.relative(process.cwd(), archivePath);

    log.info(`[CloudUpload] Uploading ${relPath} → s3://${S3_BUCKET}/${objectKey} (${(fileBuffer.length / 1_048_576).toFixed(2)} MB)…`);

    try {
        const { url, headers } = buildPutHeaders(
            S3_BUCKET, objectKey, S3_REGION, ENDPOINT, ACCESS_KEY, SECRET_KEY, fileBuffer
        );

        const statusCode = await httpPut(url, headers, fileBuffer);
        log.info(`[CloudUpload] ✓ Uploaded ${relPath} → s3://${S3_BUCKET}/${objectKey} (HTTP ${statusCode}).`);

        // Stamp the manifest so cleanup.ts knows this archive is backed up
        const manifestPath = archivePath.replace('.tar.gz', '.manifest.json');
        if (fs.existsSync(manifestPath)) {
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as ArchiveManifest & { uploadedAt?: string; s3Key?: string };
            manifest.uploadedAt = new Date().toISOString();
            manifest.s3Key = `s3://${S3_BUCKET}/${objectKey}`;
            fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
        }

        return true;
    } catch (err: any) {
        log.error(`[CloudUpload] Upload failed for ${relPath}: ${err.message}`);
        return false;
    }
}

/**
 * Finds all local archives that have NOT yet been uploaded (no uploadedAt in manifest)
 * and uploads them sequentially.
 *
 * Sequential (not parallel) to avoid saturating the server NIC.
 */
export async function uploadAllPendingArchives(): Promise<{ uploaded: number; failed: number }> {
    if (!ENABLED) {
        log.info('[CloudUpload] CLOUD_UPLOAD_ENABLED=false — skipping.');
        return { uploaded: 0, failed: 0 };
    }

    const findArchiveFiles = (dir: string): string[] => {
        if (!fs.existsSync(dir)) return [];
        const results: string[] = [];
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) results.push(...findArchiveFiles(full));
            else if (entry.isFile() && entry.name.endsWith('.tar.gz')) results.push(full);
        }
        return results;
    };

    const allArchives = findArchiveFiles(ARCHIVES_ROOT);
    const pending = allArchives.filter((fp) => {
        const mp = fp.replace('.tar.gz', '.manifest.json');
        if (!fs.existsSync(mp)) return true; // no manifest → treat as pending
        try {
            const m: any = JSON.parse(fs.readFileSync(mp, 'utf-8'));
            return !m.uploadedAt; // uploadedAt missing → not yet uploaded
        } catch {
            return true;
        }
    });

    log.info(`[CloudUpload] ${pending.length} archive(s) pending upload out of ${allArchives.length} total.`);

    let uploaded = 0;
    let failed = 0;

    for (const fp of pending) {
        const ok = await uploadArchive(fp);
        if (ok) uploaded++;
        else failed++;
    }

    log.info(`[CloudUpload] Done. Uploaded: ${uploaded} | Failed: ${failed}.`);
    return { uploaded, failed };
}
