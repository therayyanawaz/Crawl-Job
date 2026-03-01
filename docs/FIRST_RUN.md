# First Run Setup

This guide is the required setup path for a clean machine.

## 1. Node version

This project is pinned to Node `v20.19.0` via [`.nvmrc`](../.nvmrc).

```bash
nvm install
nvm use
node -v
```

## 2. Install dependencies

```bash
npm ci
```

## 3. Create environment file

```bash
cp .env.example .env
```

Set these required DB variables in `.env`:

- `DB_HOST`
- `DB_PORT`
- `DB_USER`
- `DB_PASSWORD`
- `DB_NAME`

Set source keys (at minimum):

- `SERPER_API_KEY`

## 4. Validate environment before running

```bash
npm run env:check
```

If validation fails, the script prints missing keys and exits with a non-zero status.

## 5. Run checks and start

```bash
npm run lint
npm run typecheck
npm test
npm start
```
