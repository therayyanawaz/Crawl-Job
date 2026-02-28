#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
# Job Crawler — Full Server Setup Script
# ═══════════════════════════════════════════════════════════════════════════════
#
# This script installs EVERY dependency required to run the job-crawler project
# on a fresh Ubuntu 22.04/24.04 server. Run it once after cloning the repo.
#
# Usage:
#   chmod +x scripts/setup-server.sh
#   sudo ./scripts/setup-server.sh
#
# What it installs:
#   1. System packages (build tools, libs needed by Playwright/Chromium)
#   2. Node.js 22.x LTS via NodeSource
#   3. npm project dependencies (npm ci)
#   4. Playwright browsers + OS-level deps (Chromium, Firefox, WebKit)
#   5. Creates required storage directories
#   6. Optional: systemd service file for production
#
# ═══════════════════════════════════════════════════════════════════════════════

set -euo pipefail

# ─── Colors ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

info()    { echo -e "${CYAN}[INFO]${NC}  $*"; }
success() { echo -e "${GREEN}[  OK]${NC}  $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error()   { echo -e "${RED}[FAIL]${NC}  $*"; exit 1; }
step()    { echo -e "\n${BOLD}━━━ Step $1: $2 ━━━${NC}"; }

# ─── Pre-flight Checks ────────────────────────────────────────────────────────

if [[ $EUID -ne 0 ]]; then
    error "This script must be run as root (use: sudo ./scripts/setup-server.sh)"
fi

# Detect the actual user who called sudo (for non-root installs later)
REAL_USER="${SUDO_USER:-$(whoami)}"
REAL_HOME=$(eval echo "~${REAL_USER}")

# Detect project directory (script lives in <project>/scripts/)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

info "Project directory: ${PROJECT_DIR}"
info "Running as root, real user: ${REAL_USER} (home: ${REAL_HOME})"

# Detect Ubuntu version
if [[ -f /etc/os-release ]]; then
    . /etc/os-release
    info "OS detected: ${PRETTY_NAME}"
else
    warn "Could not detect OS version. Proceeding anyway..."
fi

# ═══════════════════════════════════════════════════════════════════════════════
# STEP 1: System packages
# ═══════════════════════════════════════════════════════════════════════════════
step 1 "Installing system packages & build tools"

export DEBIAN_FRONTEND=noninteractive

apt-get update -qq

# Core build tools + libraries
apt-get install -y --no-install-recommends \
    curl \
    wget \
    gnupg \
    ca-certificates \
    apt-transport-https \
    software-properties-common \
    build-essential \
    git \
    unzip \
    tar \
    gzip \
    rsync \
    jq \
    lsb-release \
    postgresql \
    postgresql-contrib \
    libpq-dev \
    || error "Failed to install core system packages (including PostgreSQL)"

success "Core system packages installed."

# ═══════════════════════════════════════════════════════════════════════════════
# STEP 2: Playwright OS-level dependencies (Chromium/headless browser libs)
# ═══════════════════════════════════════════════════════════════════════════════
step 2 "Installing Playwright/Chromium system dependencies"

# These are ALL the shared libraries that Chromium, Firefox, and WebKit need.
# Playwright's own `npx playwright install-deps` does the same thing, but we
# install them explicitly here so the script is fully self-contained.
apt-get install -y --no-install-recommends \
    libasound2t64 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libatspi2.0-0 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxrandr2 \
    libxshmfence1 \
    libxkbcommon0 \
    libwayland-client0 \
    libwayland-server0 \
    fonts-liberation \
    fonts-noto-color-emoji \
    xdg-utils \
    xvfb \
    2>/dev/null || {
    # Fallback: some package names differ across Ubuntu versions
    warn "Some Playwright dep packages may have different names on this OS version."
    warn "Will rely on 'npx playwright install-deps' as fallback (see Step 5)."
}

success "Playwright system dependencies installed."

# ═══════════════════════════════════════════════════════════════════════════════
# STEP 3: PostgreSQL Database & User Setup
# ═══════════════════════════════════════════════════════════════════════════════
step 3 "Configuring PostgreSQL"

# Start PG if not running
systemctl start postgresql
systemctl enable postgresql

# Load credentials from .env if it exists, otherwise use defaults
DB_NAME="job_crawler"
DB_USER="testrayyan1"
DB_PASS="t24P4cu>\$I£\""

if [[ -f "${PROJECT_DIR}/.env" ]]; then
    info "Reading credentials from existing .env..."
    # Simple grep/sed to extract vars without sourcing (safety)
    DB_NAME=$(grep "^PGDATABASE=" "${PROJECT_DIR}/.env" | cut -d'=' -f2 | tr -d '"' || echo "$DB_NAME")
    DB_USER=$(grep "^PGUSER=" "${PROJECT_DIR}/.env" | cut -d'=' -f2 | tr -d '"' || echo "$DB_USER")
    DB_PASS=$(grep "^PGPASSWORD=" "${PROJECT_DIR}/.env" | cut -d'=' -f2 | tr -d '"' || echo "$DB_PASS")
fi

info "Setting up database: ${DB_NAME} for user: ${DB_USER}"

# 1. Create User if not exists
sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'" | grep -q 1 || \
    sudo -u postgres psql -c "CREATE USER ${DB_USER} WITH PASSWORD '${DB_PASS}';"

# 2. Create Database if not exists
sudo -u postgres psql -lqt | cut -d \| -f 1 | grep -qw "${DB_NAME}" || \
    sudo -u postgres psql -c "CREATE DATABASE ${DB_NAME} OWNER ${DB_USER};"

# 3. Grant privileges
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE ${DB_NAME} TO ${DB_USER};"
sudo -u postgres psql -d "${DB_NAME}" -c "GRANT ALL ON SCHEMA public TO ${DB_USER};"

success "PostgreSQL configured."

# ═══════════════════════════════════════════════════════════════════════════════
# STEP 4: Node.js 22.x LTS
# ═══════════════════════════════════════════════════════════════════════════════
step 4 "Installing Node.js 22.x LTS"

# Check if Node is already installed and at the right major version
EXISTING_NODE_VERSION=""
if command -v node &>/dev/null; then
    EXISTING_NODE_VERSION=$(node --version 2>/dev/null || echo "")
    info "Existing Node.js version: ${EXISTING_NODE_VERSION}"
fi

if [[ "$EXISTING_NODE_VERSION" == v22.* ]]; then
    success "Node.js 22.x already installed (${EXISTING_NODE_VERSION}). Skipping."
else
    info "Installing Node.js 22.x via NodeSource..."

    # Remove old NodeSource list if present
    rm -f /etc/apt/sources.list.d/nodesource.list 2>/dev/null || true
    rm -f /etc/apt/keyrings/nodesource.gpg 2>/dev/null || true

    # NodeSource setup script (official method)
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -

    apt-get install -y nodejs || error "Failed to install Node.js"

    success "Node.js $(node --version) installed."
fi

info "npm version: $(npm --version)"

# ═══════════════════════════════════════════════════════════════════════════════
# STEP 5: Project npm dependencies
# ═══════════════════════════════════════════════════════════════════════════════
step 5 "Installing project npm dependencies"

cd "$PROJECT_DIR"

# Use npm ci for reproducible installs if lockfile exists, else npm install
if [[ -f package-lock.json ]]; then
    info "Found package-lock.json — running npm ci for reproducible install..."
    sudo -u "$REAL_USER" npm ci --prefer-offline 2>&1 || {
        warn "npm ci failed, falling back to npm install..."
        sudo -u "$REAL_USER" npm install 2>&1 || error "npm install failed"
    }
else
    info "No lockfile found — running npm install..."
    sudo -u "$REAL_USER" npm install 2>&1 || error "npm install failed"
fi

success "npm dependencies installed."

# ═══════════════════════════════════════════════════════════════════════════════
# STEP 6: Playwright browsers
# ═══════════════════════════════════════════════════════════════════════════════
step 6 "Installing Playwright browsers"

# Install OS-level deps via Playwright's own detection (catches anything we missed)
npx playwright install-deps 2>&1 || warn "playwright install-deps had warnings (non-fatal)"

# Download browser binaries as the real user (they go to ~/.cache/ms-playwright/)
sudo -u "$REAL_USER" npx playwright install 2>&1 || error "Failed to install Playwright browsers"

success "Playwright browsers installed to ${REAL_HOME}/.cache/ms-playwright/"

# ═══════════════════════════════════════════════════════════════════════════════
# STEP 7: Create required directories
# ═══════════════════════════════════════════════════════════════════════════════
step 7 "Creating project storage directories"

STORAGE_DIRS=(
    "${PROJECT_DIR}/storage"
    "${PROJECT_DIR}/storage/datasets"
    "${PROJECT_DIR}/storage/key_value_stores"
    "${PROJECT_DIR}/storage/request_queues"
    "${PROJECT_DIR}/storage/archives"
    "${PROJECT_DIR}/storage/dedup"
)

for dir in "${STORAGE_DIRS[@]}"; do
    mkdir -p "$dir"
    chown "$REAL_USER":"$REAL_USER" "$dir"
done

success "Storage directories created."

# ═══════════════════════════════════════════════════════════════════════════════
# STEP 8: Create .env file if missing
# ═══════════════════════════════════════════════════════════════════════════════
step 8 "Checking .env configuration"

ENV_FILE="${PROJECT_DIR}/.env"
if [[ ! -f "$ENV_FILE" ]]; then
    info "Creating default .env file..."
    cat > "$ENV_FILE" << 'ENVEOF'
# ─── Job Crawler Configuration ────────────────────────────────────────────────
# Uncomment and modify as needed.

# Logging level: DEBUG, INFO, WARNING, ERROR
# CRAWLEE_LOG_LEVEL=INFO

# Maximum concurrent browser pages
# CRAWLEE_MAX_CONCURRENCY=6

# Memory limit in MB (useful for constrained servers)
# CRAWLEE_MEMORY_MBYTES=2048

# Proxy configuration
# PROXY_URLS=http://user:pass@proxy1:8080,http://user:pass@proxy2:8080
# PROXY_MIN_COUNT=5
# PROXY_REFRESH_INTERVAL_MINUTES=15

# Rate limiting (set to 'false' to disable)
# ENABLE_DOMAIN_RATE_LIMITING=true

# Health check interval in ms (default: 5min)
# HEALTH_CHECK_INTERVAL_MS=300000

# Alert webhook (Slack, Discord, etc.) — leave empty to disable alerts
# ALERT_WEBHOOK_URL=

# Cloud upload (S3-compatible) — for archive uploads
# S3_BUCKET=
# S3_REGION=
# AWS_ACCESS_KEY_ID=
# AWS_SECRET_ACCESS_KEY=
ENVEOF
    chown "$REAL_USER":"$REAL_USER" "$ENV_FILE"
    success "Default .env created at ${ENV_FILE}"
else
    success ".env already exists. Skipping."
fi

# ═══════════════════════════════════════════════════════════════════════════════
# STEP 9: Optional systemd service
# ═══════════════════════════════════════════════════════════════════════════════
step 9 "Setting up systemd service (optional)"

SERVICE_FILE="/etc/systemd/system/job-crawler.service"
if [[ ! -f "$SERVICE_FILE" ]]; then
    cat > "$SERVICE_FILE" << SERVICEEOF
[Unit]
Description=Job Crawler — Playwright-based job scraper
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${REAL_USER}
Group=${REAL_USER}
WorkingDirectory=${PROJECT_DIR}
ExecStart=$(which node) --import tsx src/main.ts --verbose
Restart=on-failure
RestartSec=30
StartLimitBurst=5
StartLimitIntervalSec=300

# Environment
Environment=NODE_ENV=production
EnvironmentFile=-${PROJECT_DIR}/.env

# Resource limits
MemoryMax=4G
CPUQuota=200%

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=job-crawler

# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=${PROJECT_DIR}/storage ${REAL_HOME}/.cache/ms-playwright

[Install]
WantedBy=multi-user.target
SERVICEEOF

    systemctl daemon-reload
    success "systemd service created at ${SERVICE_FILE}"
    info "  Start:   sudo systemctl start job-crawler"
    info "  Enable:  sudo systemctl enable job-crawler"
    info "  Logs:    journalctl -u job-crawler -f"
else
    success "systemd service already exists. Skipping."
fi

# ═══════════════════════════════════════════════════════════════════════════════
# STEP 10: Verification
# ═══════════════════════════════════════════════════════════════════════════════
step 10 "Verifying installation"

echo ""
PASS=true

# Check Node
if command -v node &>/dev/null; then
    success "Node.js:    $(node --version)"
else
    error "Node.js not found!"
    PASS=false
fi

# Check npm
if command -v npm &>/dev/null; then
    success "npm:        $(npm --version)"
else
    error "npm not found!"
    PASS=false
fi

# Check tsx
if [[ -f "${PROJECT_DIR}/node_modules/.bin/tsx" ]]; then
    success "tsx:        installed"
else
    warn "tsx not found in node_modules (may cause issues)"
    PASS=false
fi

# Check Playwright browsers
PW_CACHE="${REAL_HOME}/.cache/ms-playwright"
if [[ -d "$PW_CACHE" ]] && [[ $(find "$PW_CACHE" -maxdepth 1 -type d | wc -l) -gt 1 ]]; then
    BROWSER_COUNT=$(find "$PW_CACHE" -maxdepth 1 -type d | tail -n +2 | wc -l)
    success "Playwright: ${BROWSER_COUNT} browser(s) installed in ${PW_CACHE}"
else
    error "Playwright browsers not found in ${PW_CACHE}"
    PASS=false
fi

# Check node_modules
if [[ -d "${PROJECT_DIR}/node_modules/crawlee" ]]; then
    success "crawlee:    installed"
else
    error "crawlee not found in node_modules"
    PASS=false
fi

if [[ -d "${PROJECT_DIR}/node_modules/playwright" ]]; then
    success "playwright: installed"
else
    error "playwright npm package not found"
    PASS=false
fi

# Check storage dirs
if [[ -d "${PROJECT_DIR}/storage" ]]; then
    success "storage/:   exists"
else
    error "storage/ directory missing"
    PASS=false
fi

echo ""
echo -e "${BOLD}═══════════════════════════════════════════════════════════════════${NC}"
if $PASS; then
    echo -e "${GREEN}${BOLD}  ✅ All checks passed! Your server is ready.${NC}"
    echo ""
    echo -e "  ${CYAN}Run manually:${NC}"
    echo -e "    cd ${PROJECT_DIR}"
    echo -e "    npm start -- --verbose"
    echo ""
    echo -e "  ${CYAN}Run as a service:${NC}"
    echo -e "    sudo systemctl start job-crawler"
    echo -e "    sudo systemctl enable job-crawler    # auto-start on boot"
    echo -e "    journalctl -u job-crawler -f          # tail logs"
else
    echo -e "${RED}${BOLD}  ⚠️  Some checks failed. Review the output above.${NC}"
fi
echo -e "${BOLD}═══════════════════════════════════════════════════════════════════${NC}"
echo ""
