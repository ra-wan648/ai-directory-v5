# Setup Guide - AI Tools Directory

This guide covers Cloudflare, Telegram and Manifest.build setup.
Secrets are entered ONLY by the owner into GitHub Actions Secrets.
Never paste secret values into chat or commit them to files.

═══════════════════════════════════════════════════════
1. GITHUB (done)
═══════════════════════════════════════════════════════
- Repo created and bound. URL needed from owner.

═══════════════════════════════════════════════════════
2. CLOUDFLARE
═══════════════════════════════════════════════════════
Cloudflare is NOT a git identity. It connects via API Token.
Two ways:

A) If the platform has a "Cloudflare" binding/integration option
   (same place you bound GitHub), click Bind and authorize.
   This is the easiest path.

B) Otherwise, create an API Token and put it in GitHub Secrets:

   1. Go to https://dash.cloudflare.com/profile/api-tokens
   2. Click "Create Token"
   3. Choose template: "Edit Cloudflare Workers"
   4. Account Resources: your account, all accounts
   5. Zone Resources: include all zones
   6. Permissions: ensure Workers Scripts (Edit) + D1 (Edit) + Pages (Edit)
   7. Create Token, copy it NOW (shown once)
   8. Add to GitHub Secrets as CF_API_TOKEN
   9. Account ID: dashboard -> right avatar -> My Profile ->
      "Account ID" at top. Add to GitHub Secrets as CF_ACCOUNT_ID
   10. D1 Database ID: Workers & Pages -> D1 -> ai-directory-db ->
       copy ID. Add to GitHub Secrets as CF_D1_ID

Then tell the agent: "Cloudflare secrets added to GitHub."
The agent will use the token only to run deploy commands via
GitHub Actions / wrangler. The token value is never shown.

═══════════════════════════════════════════════════════
3. TELEGRAM (owner does this themselves)
═══════════════════════════════════════════════════════
A) Create the bot:
   1. Open Telegram, search "@BotFather"
   2. Send: /newbot
   3. Bot name: AI Directory Admin
   4. Bot username: <your_directory>_admin_bot
   5. BotFather replies with a token like:
      7123456789:AAH...copy this
   6. Add to GitHub Secrets as TELEGRAM_BOT_TOKEN

B) Get your admin chat ID:
   1. Search "@userinfobot" in Telegram
   2. Send any message (e.g. /start)
   3. It replies: "Your ID: 123456789"
   4. Add to GitHub Secrets as ADMIN_TELEGRAM_ID

C) Start a chat with your new bot so it can message you
   (click the bot -> press Start).

═══════════════════════════════════════════════════════
4. MANIFEST.BUILD / LLM
═══════════════════════════════════════════════════════
The pipeline reads these two env vars (see scripts/llm.py):
  MANIFEST_BASE_URL   -> https://api.manifest.build/v1
  MANIFEST_API_KEY    -> your key from manifest.build

Where they live (owner fills values, agent never sees them):

  a) GitHub Actions Secrets (for the scheduled pipeline):
     Add MANIFEST_BASE_URL and MANIFEST_API_KEY as repo secrets.

  b) Local run (optional): create file scripts/.env.local
     MANIFEST_BASE_URL=https://api.manifest.build/v1
     MANIFEST_API_KEY=your-key-here
     MANIFEST_API_KEY placeholder value in .env.local is NEVER
     committed. This file is gitignored.

The agent creates the placeholder files and wiring; the owner
fills in the real values. No secrets are written into schema,
worker, or committed config.

═══════════════════════════════════════════════════════
5. INTERNAL API KEY (agent generates, stores in secret)
═══════════════════════════════════════════════════════
The agent will generate a random 32-char key for X-Internal-Key.
It is added to GitHub Secrets as INTERNAL_API_KEY and to
wrangler.toml vars. Value shown only when the owner must copy it
into GitHub Secrets.

═══════════════════════════════════════════════════════
6. WORKER URL
═══════════════════════════════════════════════════════
After the Worker is deployed, its URL (e.g.
https://ai-directory-worker.<account>.workers.dev) is added to
GitHub Secrets as WORKER_URL. The owner copies it in, or the
agent instructs step by step.
