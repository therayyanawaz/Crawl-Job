#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
    const args = { file: '.env' };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--file' && argv[i + 1]) {
            args.file = argv[i + 1];
            i++;
        }
    }
    return args;
}

function parseEnvFile(filePath) {
    if (!fs.existsSync(filePath)) return {};
    const raw = fs.readFileSync(filePath, 'utf8');
    const env = {};
    for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const idx = trimmed.indexOf('=');
        if (idx <= 0) continue;
        const key = trimmed.slice(0, idx).trim();
        const value = trimmed.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
        env[key] = value;
    }
    return env;
}

function isUnset(value) {
    return value === undefined || value === null || String(value).trim() === '';
}

function looksLikePlaceholder(value) {
    if (isUnset(value)) return true;
    const v = String(value).trim().toLowerCase();
    const bracketPlaceholder = /^<[^>]+>$/.test(v);
    return (
        bracketPlaceholder ||
        v.includes('your_') ||
        v.includes('changeme') ||
        v === 'example' ||
        v === 'placeholder'
    );
}

function firstNonEmpty(values) {
    for (const v of values) {
        if (!isUnset(v)) return String(v).trim();
    }
    return '';
}

const args = parseArgs(process.argv.slice(2));
const envPath = path.isAbsolute(args.file) ? args.file : path.join(process.cwd(), args.file);
const fileEnv = parseEnvFile(envPath);
const merged = { ...fileEnv, ...process.env };

const databaseUrl = firstNonEmpty([merged.DATABASE_URL]);
const usingDatabaseUrl = !isUnset(databaseUrl);

const dbHost = firstNonEmpty([merged.DB_HOST, merged.PGHOST]);
const dbPort = firstNonEmpty([merged.DB_PORT, merged.PGPORT]);
const dbUser = firstNonEmpty([merged.DB_USER, merged.PGUSER]);
const dbPassword = firstNonEmpty([merged.DB_PASSWORD, merged.PGPASSWORD]);
const dbName = firstNonEmpty([merged.DB_NAME, merged.PGDATABASE]);

const errors = [];
if (!usingDatabaseUrl) {
    if (isUnset(dbHost)) errors.push('DB_HOST (or PGHOST)');
    if (isUnset(dbPort)) errors.push('DB_PORT (or PGPORT)');
    if (isUnset(dbUser)) errors.push('DB_USER (or PGUSER)');
    if (isUnset(dbPassword)) errors.push('DB_PASSWORD (or PGPASSWORD)');
    if (isUnset(dbName)) errors.push('DB_NAME (or PGDATABASE)');
}

if (usingDatabaseUrl && looksLikePlaceholder(databaseUrl)) {
    errors.push('DATABASE_URL appears to be a placeholder');
}
if (!usingDatabaseUrl) {
    if (looksLikePlaceholder(dbHost)) errors.push('DB_HOST appears to be a placeholder');
    if (looksLikePlaceholder(dbUser)) errors.push('DB_USER appears to be a placeholder');
    if (looksLikePlaceholder(dbPassword)) errors.push('DB_PASSWORD appears to be a placeholder');
    if (looksLikePlaceholder(dbName)) errors.push('DB_NAME appears to be a placeholder');
}

if (!isUnset(dbPort) && !/^\d+$/.test(dbPort)) {
    errors.push(`DB_PORT must be numeric, got "${dbPort}"`);
}

if (errors.length > 0) {
    console.error(`[env:check] Validation failed (${envPath})`);
    for (const err of errors) {
        console.error(`- ${err}`);
    }
    process.exit(1);
}

console.log(`[env:check] OK (${envPath})`);
