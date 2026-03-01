import { ZodError } from 'zod';
import { envSchema, type Env } from './envSchema.js';

function withDbAliases(raw: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const next = { ...raw };
    if (!next.PGHOST && next.DB_HOST) next.PGHOST = next.DB_HOST;
    if (!next.PGPORT && next.DB_PORT) next.PGPORT = next.DB_PORT;
    if (!next.PGUSER && next.DB_USER) next.PGUSER = next.DB_USER;
    if (!next.PGPASSWORD && next.DB_PASSWORD) next.PGPASSWORD = next.DB_PASSWORD;
    if (!next.PGDATABASE && next.DB_NAME) next.PGDATABASE = next.DB_NAME;
    return next;
}

let env: Env;
try {
    env = envSchema.parse(withDbAliases(process.env));
} catch (err) {
    if (err instanceof ZodError) {
        const lines = err.issues.map((i) => {
            const key = i.path.join('.') || '(root)';
            return `- ${key}: ${i.message}`;
        });
        const message =
            'Invalid environment variables:\n' +
            lines.join('\n');
        const e = new Error(message);
        console.error(e.message);
        process.exit(1);
        throw e;
    }
    throw err;
}

export { env };
export type { Env };
