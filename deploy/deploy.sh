#!/usr/bin/env bash
# deploy/deploy.sh
#
# Production deployment script for crawl-job.
#
# USAGE:
#   sudo -u crawl-job bash deploy/deploy.sh          # first deploy
#   sudo -u crawl-job bash deploy/deploy.sh --update # subsequent updates
#
# The script must be run as the crawl-job user (not root) so that
# nvm and npm paths resolve correctly.
#
# WHAT IT DOES:
#   1. Validates runtime environment
#   2. Pulls latest code from git (if --update flag passed)
#   3. Installs / updates npm dependencies
#   4. Compiles TypeScript to dist/
#   5. Verifies compilation succeeded
#   6. Restarts the systemd service (or starts it for the first time)
#   7. Waits for the service to confirm healthy startup
#   8. Prints final status
#
# EXIT CODES:
#   0 = success
#   1 = any step failed (service is NOT restarted if build fails)

set -euo pipefail  # Exit on error, undefined variable, or pipe failure
IFS=$'\n\t'

# ─── Configuration ────────────────────────────────────────────────────────────

PROJECT_DIR="/opt/crawl-job"
SERVICE_NAME="crawl-job"
NODE_VERSION="v20.19.0"
NVM_DIR="/home/crawl-job/.nvm"
NODE_BIN="${NVM_DIR}/versions/node/${NODE_VERSION}/bin"
NODE="${NODE_BIN}/node"
NPM="${NODE_BIN}/npm"
NPX="${NODE_BIN}/npx"
LOG_FILE="${PROJECT_DIR}/deploy.log"

# ─── Colours ──────────────────────────────────────────────────────────────────

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

info()    { echo -e "${CYAN}[INFO]${RESET}  $*" | tee -a "$LOG_FILE"; }
success() { echo -e "${GREEN}[OK]${RESET}    $*" | tee -a "$LOG_FILE"; }
warn()    { echo -e "${YELLOW}[WARN]${RESET}  $*" | tee -a "$LOG_FILE"; }
error()   { echo -e "${RED}[ERROR]${RESET} $*" | tee -a "$LOG_FILE"; exit 1; }
step()    { echo -e "\n${BOLD}━━━ $* ━━━${RESET}" | tee -a "$LOG_FILE"; }

# ─── Timestamp header ─────────────────────────────────────────────────────────

echo "" | tee -a "$LOG_FILE"
echo "════════════════════════════════════════════" | tee -a "$LOG_FILE"
echo " Deploy started: $(date '+%Y-%m-%dT%H:%M:%S%z')" | tee -a "$LOG_FILE"
echo "════════════════════════════════════════════" | tee -a "$LOG_FILE"

# ─── Step 0: Validate environment ────────────────────────────────────────────

step "0. Environment validation"

# Must be running as crawl-job user
if [[ "$(whoami)" != "crawl-job" ]]; then
    error "This script must be run as 'crawl-job'. Use: sudo -u crawl-job bash deploy/deploy.sh"
fi

# Node binary must exist
if [[ ! -x "$NODE" ]]; then
    error "Node not found at $NODE. Run setup.sh first or check NODE_VERSION in this script."
fi

info "Node: $("$NODE" --version)"
info "npm:  $("$NPM" --version)"
info "Project: $PROJECT_DIR"
info "Service: $SERVICE_NAME"

# ─── Step 1: Git pull (only with --update flag) ───────────────────────────────

step "1. Source code"

if [[ "${1:-}" == "--update" ]]; then
    info "Pulling latest code from git…"
    cd "$PROJECT_DIR"

    # Stash any local changes to prevent pull conflicts
    if ! git diff --quiet; then
        warn "Uncommitted local changes detected. Stashing before pull."
        git stash push -m "deploy-$(date +%s)"
    fi

    PREVIOUS_COMMIT=$(git rev-parse HEAD)
    git pull --ff-only origin main
    NEW_COMMIT=$(git rev-parse HEAD)

    if [[ "$PREVIOUS_COMMIT" == "$NEW_COMMIT" ]]; then
        info "Already at latest commit ($NEW_COMMIT). No code changes."
    else
        info "Updated: ${PREVIOUS_COMMIT:0:8} → ${NEW_COMMIT:0:8}"
    fi
else
    info "Skipping git pull (no --update flag). Using current code."
    cd "$PROJECT_DIR"
fi

success "Working directory: $PROJECT_DIR ($(git rev-parse --short HEAD 2>/dev/null || echo 'no-git'))"

# ─── Step 2: Backup previous build ───────────────────────────────────────────

step "2. Backup previous build"

BACKUP_DIR="${PROJECT_DIR}/.backups/$(date +%Y%m%d-%H%M%S)"
if [[ -d "${PROJECT_DIR}/dist" ]]; then
    mkdir -p "$BACKUP_DIR"
    cp -r "${PROJECT_DIR}/dist" "${BACKUP_DIR}/dist"
    success "Previous dist/ backed up to $BACKUP_DIR"
else
    info "No previous dist/ found — skipping backup."
fi

# ─── Step 3: Install dependencies ────────────────────────────────────────────

step "3. npm install"

"$NPM" ci --omit=dev 2>&1 | tee -a "$LOG_FILE"
# npm ci is faster and stricter than npm install —
# it uses package-lock.json exactly and cleans node_modules first.

success "Dependencies installed."

# ─── Step 4: TypeScript compilation ──────────────────────────────────────────

step "4. TypeScript build"

# Run type-checking first (fast, catches errors before generating output)
info "Type-checking…"
"$NPX" tsc --noEmit 2>&1 | tee -a "$LOG_FILE" \
    || error "TypeScript type errors found. Fix errors in src/ before deploying."

# Full compilation to ./dist
info "Compiling to dist/…"
"$NPX" tsc 2>&1 | tee -a "$LOG_FILE" \
    || error "TypeScript compilation failed. Previous dist/ backup preserved."

success "Compiled to dist/."

# Verify the entry point exists
if [[ ! -f "${PROJECT_DIR}/dist/main.js" ]]; then
    error "dist/main.js not found after compilation. Check tsconfig.json outDir."
fi

success "Entry point verified: dist/main.js"

# ─── Step 5: Fix permissions ──────────────────────────────────────────────────

step "5. Permissions"

# Ensure storage directory exists and is owned by the service user
mkdir -p "${PROJECT_DIR}/storage"
chown -R crawl-job:crawl-job "${PROJECT_DIR}/storage" 2>/dev/null \
    || warn "Could not chown storage/ — run: sudo chown -R crawl-job:crawl-job ${PROJECT_DIR}/storage"

success "Permissions verified."

# ─── Step 6: Restart service ──────────────────────────────────────────────────

step "6. Service restart"

# Check if running as a user that can control systemctl
# (crawl-job user needs: sudo systemctl restart crawl-job)
if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
    info "Service is running. Restarting…"
    sudo systemctl restart "$SERVICE_NAME" \
        || error "systemctl restart failed. Check: sudo journalctl -u $SERVICE_NAME -n 50"
    success "Service restarted."
else
    info "Service is not running. Starting…"
    sudo systemctl start "$SERVICE_NAME" \
        || error "systemctl start failed. Check: sudo journalctl -u $SERVICE_NAME -n 50"
    success "Service started."
fi

# ─── Step 7: Health verification ─────────────────────────────────────────────

step "7. Health verification"

info "Waiting 15 seconds for service to stabilise…"
sleep 15

# Check systemd reports the service as active
STATUS=$(systemctl is-active "$SERVICE_NAME" 2>/dev/null || echo "unknown")
if [[ "$STATUS" != "active" ]]; then
    error "Service status is '$STATUS' (expected 'active'). Check logs: sudo journalctl -u $SERVICE_NAME -n 100"
fi

success "Service is active."

# Check the process is actually running (not a zombie)
PID=$(systemctl show -p MainPID --value "$SERVICE_NAME" 2>/dev/null || echo "0")
if [[ "$PID" == "0" || "$PID" == "" ]]; then
    warn "Could not determine PID — service may have crashed immediately after start."
else
    success "Main PID: $PID"
    # Check RSS memory from /proc
    RSS_KB=$(cat "/proc/$PID/status" 2>/dev/null | grep VmRSS | awk '{print $2}' || echo "0")
    RSS_MB=$((RSS_KB / 1024))
    info "Current memory (RSS): ${RSS_MB} MB"
fi

# ─── Step 8: Summary ──────────────────────────────────────────────────────────

step "8. Deploy summary"

echo ""
echo "════════════════════════════════════════════"
echo -e " ${GREEN}✓ Deployment completed successfully${RESET}"
echo " $(date '+%Y-%m-%dT%H:%M:%S%z')"
echo ""
echo " Service: $SERVICE_NAME ($STATUS)"
echo " Logs:    sudo journalctl -u $SERVICE_NAME -f"
echo " Status:  sudo systemctl status $SERVICE_NAME"
echo " Metrics: cat ${PROJECT_DIR}/storage/metrics-snapshot.json"
echo " Health:  cat ${PROJECT_DIR}/storage/health-report.json"
echo "════════════════════════════════════════════"

# ─── Rollback function (not called automatically) ─────────────────────────────
#
# To roll back to the previous build manually:
#   sudo systemctl stop crawl-job
#   sudo -u crawl-job bash -c '
#     BACKUP=$(ls -1dt /opt/crawl-job/.backups/* | head -1)
#     cp -r "$BACKUP/dist" /opt/crawl-job/dist
#   '
#   sudo systemctl start crawl-job
#
