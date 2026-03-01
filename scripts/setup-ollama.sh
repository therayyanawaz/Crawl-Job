#!/bin/bash
# scripts/setup-ollama.sh
# 
# Installs Ollama (if not already installed), reads configuration from .env,
# and pulls the specified language model.

set -e

echo "============================================================"
echo "    Crawl-Job — Ollama LLM Setup Script                   "
echo "============================================================"

# Switch to the project directory
cd "$(dirname "$0")/.."

# 1. Read variables from .env if present
ENV_FILE=".env"
OLLAMA_MODEL="qwen2.5:32b-instruct-q8_0" # default
OLLAMA_BASE_URL="http://localhost:11434" # default

if [ -f "$ENV_FILE" ]; then
    echo "[$ENV_FILE] Found. Reading configuration..."
    # Read variables ignoring comments
    MODEL_FROM_ENV=$(grep -E '^OLLAMA_MODEL=' "$ENV_FILE" | cut -d '=' -f2)
    URL_FROM_ENV=$(grep -E '^OLLAMA_BASE_URL=' "$ENV_FILE" | cut -d '=' -f2)
    
    if [ -n "$MODEL_FROM_ENV" ]; then
        OLLAMA_MODEL=$MODEL_FROM_ENV
    fi
    if [ -n "$URL_FROM_ENV" ]; then
        OLLAMA_BASE_URL=$URL_FROM_ENV
    fi
else
    echo "[$ENV_FILE] Not found. Using defaults."
fi

echo "Model to operate on: $OLLAMA_MODEL"
echo "Ollama API URL:      $OLLAMA_BASE_URL"
echo ""

# 2. Check if Ollama is installed
if ! command -v ollama &> /dev/null; then
    echo "[Setup] Ollama is not installed. Installing now..."
    # Warning: this uses the official install script for Linux/macOS
    curl -fsSL https://ollama.com/install.sh | sh
    echo "[Setup] Ollama installed successfully."
else
    echo "[Setup] Ollama is already installed."
    ollama --version
fi

# 3. Ensure Ollama is running
echo ""
echo "[Setup] Checking if Ollama service is running locally on $OLLAMA_BASE_URL..."
if ! curl -s "${OLLAMA_BASE_URL}/" > /dev/null; then
    echo "⚠ Ollama does not seem to be running at $OLLAMA_BASE_URL."
    echo "If Ollama is installed locally, please start it in an external terminal by running:"
    echo ""
    echo "    ollama serve"
    echo ""
    echo "Then re-run this setup script to pull the model."
    exit 1
fi
echo "[Setup] ✓ Ollama service is running."

# 4. Pull the model
echo ""
echo "[Setup] Pulling model '$OLLAMA_MODEL'..."
echo "        (This may take a while depending on your internet connection and model size)"
ollama pull "$OLLAMA_MODEL"

echo ""
echo "============================================================"
echo "    Setup Complete!"
echo "    You can now start the job crawler with Ollama enabled."
echo "============================================================"
