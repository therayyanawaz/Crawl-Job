#!/usr/bin/env bash
# deploy/setup.sh
#
# ONE-TIME server setup script.
# Run this ONCE on a fresh Ubuntu 22.04+ / Debian 11+ server as a user
# who can sudo (NOT as root directly — nvm must run as the service user).
#
# USAGE (from your local machine):
#   ssh yourserver
#   sudo apt update && sudo apt install -y git curl
#   git clone https://github.com/youruser/crawl-job.git /opt/crawl-job
#   cd /opt/crawl-job
#   sudo bash deploy/setup.sh
#
# The script will:
#   1. Install system packages (git, curl, build-essential, chromium-browser)
#   2. Create the crawl-job system user
#   3. Install nvm + Node 20 LTS for that user
#   4. Install Playwright browser binaries
#   5. Create /etc/crawl-job/ config directory
#   6. Deploy the systemd unit file
#   7. Enable and start the service
#   8. Print a post-setup checklist

set -euo pipefail
IFS=$'\n\t'

# ─── Must run as root (sudo) ──────────────────────────────────────────────────

if [[ "$EUID" -ne 0 ]]; then
    echo "ERROR: This setup script must be run as root (sudo bash deploy/setup.sh)."
    exit 1
fi

PROJECT_DIR="/opt/crawl-job"
SERVICE_USER="crawl-job"
SERVICE_GROUP="crawl-job"
NODE_VERSION="20"   # Major version — nvm will install the latest 20.x LTS
SERVICE_UNIT_SRC="${PROJECT_DIR}/deploy/crawl-job.service"
SERVICE_UNIT_DEST="/etc/systemd/system/crawl-job.service"
ENV_DIR="/etc/crawl-job"
ENV_FILE="${ENV_DIR}/env"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " Crawl-Job — Production Server Setup"
echo " $(date '+%Y-%m-%dT%H:%M:%S%z')"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ─────────────────────────────────────────────────────────────────────────────
# STEP 1: System packages
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "── Step 1: System packages"

apt-get update -qq
apt-get install -y --no-install-recommends \
    git \
    curl \
    build-essential \
    python3 \
    ca-certificates \
    gnupg \
    lsb-release \
    procps \
    moreutils \
    mailutils \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libgbm1 \
    libxkbcommon0 \
    libnspr4 \
    libnss3 \
    libasound2 \
    libatspi2.0-0 \
    libgtk-3-0 \
    2>&1 | tail -5

# These are Playwright/Chromium's shared library dependencies on Ubuntu 22.04.
# "apt-get install -y chromium-browser" would work too but may be outdated;
# we let Playwright manage its own bundled Chromium via playwright install.

echo "✓ System packages installed."

# ─────────────────────────────────────────────────────────────────────────────
# STEP 2: Create service user
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "── Step 2: Service user"

if id "$SERVICE_USER" &>/dev/null; then
    echo "  User '$SERVICE_USER' already exists — skipping."
else
    # --system: no home directory needed? Actually we need one for nvm.
    # --create-home: nvm installs into ~/.nvm which needs a real home.
    # --shell /usr/sbin/nologin: cannot log in interactively (security).
    # --comment: description shown in passwd and ps output.
    useradd \
        --system \
        --create-home \
        --home-dir "/home/$SERVICE_USER" \
        --shell /usr/sbin/nologin \
        --comment "Crawl-Job Service Account" \
        "$SERVICE_USER"
    echo "✓ User '$SERVICE_USER' created."
fi

# Give the service user ownership of the project directory
chown -R "${SERVICE_USER}:${SERVICE_GROUP}" "$PROJECT_DIR"
chmod 750 "$PROJECT_DIR"
echo "✓ $PROJECT_DIR ownership: ${SERVICE_USER}:${SERVICE_GROUP} (750)"

# ─────────────────────────────────────────────────────────────────────────────
# STEP 3: Install nvm + Node 20 LTS for the service user
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "── Step 3: nvm + Node ${NODE_VERSION} LTS"

# Run nvm install as the service user using sudo -u + bash login shell
sudo -u "$SERVICE_USER" bash -l -c "
    set -euo pipefail

    # Install nvm if not already present
    if [[ ! -d \"\$HOME/.nvm\" ]]; then
        curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
        echo '✓ nvm installed.'
    else
        echo '  nvm already present — skipping install.'
    fi

    # Source nvm
    export NVM_DIR=\"\$HOME/.nvm\"
    source \"\$NVM_DIR/nvm.sh\"

    # Install Node 20 LTS
    nvm install ${NODE_VERSION}
    nvm alias default ${NODE_VERSION}
    nvm use default
    echo \"✓ Node: \$(node --version)\"
    echo \"✓ npm:  \$(npm --version)\"
"

# Resolve the exact versioned bin path for the service file
NODE_EXACT_VERSION=$(sudo -u "$SERVICE_USER" bash -l -c "
    export NVM_DIR=\"\$HOME/.nvm\"
    source \"\$NVM_DIR/nvm.sh\"
    nvm use default --silent
    node --version
" 2>/dev/null | tr -d 'v\r\n')

NODE_BIN="/home/${SERVICE_USER}/.nvm/versions/node/v${NODE_EXACT_VERSION}/bin"
echo "✓ Node bin path: $NODE_BIN"

# ─────────────────────────────────────────────────────────────────────────────
# STEP 4: Install npm dependencies + Playwright browser binaries
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "── Step 4: Dependencies + Playwright browsers"

sudo -u "$SERVICE_USER" bash -l -c "
    set -euo pipefail
    export NVM_DIR=\"\$HOME/.nvm\"
    source \"\$NVM_DIR/nvm.sh\"
    nvm use default --silent

    cd ${PROJECT_DIR}
    npm ci --omit=dev
    echo '✓ npm dependencies installed.'

    # Install Playwright's bundled Chromium for the service user
    npx playwright install chromium
    echo '✓ Playwright Chromium installed.'
"

# ─────────────────────────────────────────────────────────────────────────────
# STEP 5: Initial TypeScript compile
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "── Step 5: TypeScript compilation"

sudo -u "$SERVICE_USER" bash -l -c "
    set -euo pipefail
    export NVM_DIR=\"\$HOME/.nvm\"
    source \"\$NVM_DIR/nvm.sh\"
    nvm use default --silent
    cd ${PROJECT_DIR}
    npx tsc --noEmit && npx tsc
    echo '✓ Compiled to dist/'
"

# ─────────────────────────────────────────────────────────────────────────────
# STEP 6: Production environment file
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "── Step 6: /etc/crawl-job/env"

mkdir -p "$ENV_DIR"

if [[ ! -f "$ENV_FILE" ]]; then
    # Copy the production template — operator must fill in secrets afterwards
    cp "${PROJECT_DIR}/deploy/env.production" "$ENV_FILE"
    echo "✓ Created $ENV_FILE from template."
    echo "  ⚠  EDIT THIS FILE NOW to add your proxy URLs and alert webhooks."
else
    echo "  $ENV_FILE already exists — not overwriting. Review manually."
fi

# Secure permissions — crawl-job can read, others cannot
chown root:"$SERVICE_GROUP" "$ENV_FILE"
chmod 640 "$ENV_FILE"
echo "✓ Permissions: root:${SERVICE_GROUP} 640"

# ─────────────────────────────────────────────────────────────────────────────
# STEP 7: Update service file with exact Node bin path, then install
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "── Step 7: systemd unit"

# Patch the service file with the exact Node version discovered above
sed "s|/home/crawl-job/.nvm/versions/node/v20.19.0/bin|${NODE_BIN}|g" \
    "$SERVICE_UNIT_SRC" > "$SERVICE_UNIT_DEST"

systemctl daemon-reload
systemctl enable "$SERVICE_USER.service" 2>/dev/null || \
    systemctl enable "crawl-job.service"
echo "✓ Service enabled: will start on boot."

# Add sudoers rule so crawl-job can restart its own service without a password.
# This allows the deploy script to call `sudo systemctl restart crawl-job`.
SUDOERS_FILE="/etc/sudoers.d/crawl-job"
if [[ ! -f "$SUDOERS_FILE" ]]; then
    cat > "$SUDOERS_FILE" <<EOF
# Allow crawl-job user to manage its own systemd service
crawl-job ALL=(root) NOPASSWD: /bin/systemctl start crawl-job
crawl-job ALL=(root) NOPASSWD: /bin/systemctl stop crawl-job
crawl-job ALL=(root) NOPASSWD: /bin/systemctl restart crawl-job
crawl-job ALL=(root) NOPASSWD: /bin/systemctl status crawl-job
EOF
    chmod 440 "$SUDOERS_FILE"
    echo "✓ sudoers rule created: $SUDOERS_FILE"
fi

# ─────────────────────────────────────────────────────────────────────────────
# STEP 8: Start the service
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "── Step 8: Starting service"

systemctl start crawl-job
sleep 8
STATUS=$(systemctl is-active crawl-job 2>/dev/null || echo "unknown")
echo "  Service status: $STATUS"

if [[ "$STATUS" == "active" ]]; then
    echo "✓ Service is running successfully."
else
    echo "⚠  Service did not start cleanly. Check logs:"
    echo "   sudo journalctl -u crawl-job -n 50 --no-pager"
fi

# ─────────────────────────────────────────────────────────────────────────────
# POST-SETUP CHECKLIST
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " Setup Complete — Post-setup Checklist"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  [ ] Edit alerts config:   sudo nano /etc/crawl-job/env"
echo "  [ ] Add proxy URLs:       set PROXY_URLS= in that file"
echo "  [ ] Tail live logs:       sudo journalctl -u crawl-job -f"
echo "  [ ] Check health:         cat /opt/crawl-job/storage/health-report.json"
echo "  [ ] Check metrics:        cat /opt/crawl-job/storage/metrics-snapshot.json"
echo "  [ ] Test alert delivery:  (set ALERT_SLACK_WEBHOOK and restart service)"
echo ""
echo "  Useful commands:"
echo "    sudo systemctl status crawl-job"
echo "    sudo systemctl restart crawl-job"
echo "    sudo journalctl -u crawl-job --since '1 hour ago'"
echo "    sudo -u crawl-job bash /opt/crawl-job/deploy/deploy.sh --update"
echo ""
