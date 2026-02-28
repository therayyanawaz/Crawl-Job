import { ZodError } from 'zod';
import { envSchema, type Env } from './envSchema.js';

let env: Env;
try {
    env = envSchema.parse(process.env);
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
