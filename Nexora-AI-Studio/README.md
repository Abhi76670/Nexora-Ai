# Nexora AI Studio

A local AI coding workspace built with React/Vite and Node/Express, using the Gemini API from the server. Designed for Termux or a desktop Node.js environment.

## Features

- Dark chat workspace with Hindi/Hinglish-aware assistant instructions.
- Formatted code blocks with independent Copy buttons.
- Server-Sent Events for progressive response rendering and actual backend activity events.
- Per-session project workspace with file explorer, editor, file read/write/search tools.
- Upload ZIP, safe path-checked extraction, ZIP download.
- Project context notes at `.nexora/PROJECT_CONTEXT.md` can be read/updated by the agent to help resume work.
- HTML preview in a sandboxed iframe.
- Restricted terminal commands: `help`, `pwd`, `ls`, `find`, `cat <file>`, `wc <file>`, `node <file.js>`, `python3 <file.py>`, `npm install`, `npm run build`, `npm test`, and `curl` to localhost.
- 500+ total project lines trigger automatic ZIP packaging rather than requiring all code to be pasted into chat.
- Gemini API key stays in the backend `.env` file.

## Requirements

- Node.js 20+
- A Gemini API key with access to the model set in `.env`
- For Python commands, install Python in your environment (Termux: `pkg install python`)

## Firebase Authentication + persistent chats
1. In Firebase Console for project `nexora-ai-34dae`, enable **Authentication → Sign-in method → Email/Password**.
2. Create a **Cloud Firestore** database.
3. Publish the included `firestore.rules` rules.
4. The client Firebase configuration is in `client/src/firebase.js`.
5. Register with Name, Email, Password. Chats and a compact project-memory summary are stored under that authenticated user's Firestore path.
6. The server uses the client-provided project memory as context; it does not independently verify Firebase ID tokens in this starter. Before exposing this publicly, add Firebase Admin token verification on the API and authorize workspace access per UID.

## Run on Termux

```bash
pkg update
pkg install nodejs-lts unzip -y
termux-setup-storage
cd ~/storage/downloads
unzip Nexora-AI-Studio.zip
cd Nexora-AI-Studio
cp .env.example .env
nano .env
npm install
npm run dev
```

Put your key in `GEMINI_API_KEY=` in `.env`, save, then run `npm run dev`. Open the Vite URL printed in Termux, usually `http://localhost:5173`.

If using Python scripts, install Python separately with `pkg install python`. Node/Python execution runs on the same device and has a timeout/output limit; not all packages will be installed by default.

## Notes and limitations

This is a local coding-agent starter, not a secure multi-user hosted IDE. The command runner intentionally blocks arbitrary shell commands and destructive operations. It allows a standalone `npm install` inside the selected local project, which can run package lifecycle scripts; only install dependencies for projects you trust. Do not expose the server publicly without authentication, authorization, quotas and a hardened isolated runner. Untrusted code can still be dangerous when executed locally; only run code you trust.

The preview currently supports static HTML reliably. React/Next.js projects can be edited and built if their dependencies are present, but a full browser preview for every framework requires a separate managed dev-server/sandbox workflow. Python scripts can run if Python is installed; this is not a general Python web-hosting environment.

## API

- `GET /api/health`
- `POST /api/chat` — SSE events: `status`, `text`, `artifact`, `terminal`, `done`, `error`
- `GET /api/files?sessionId=...`
- `GET /api/file?sessionId=...&path=...`
- `POST /api/file`
- `POST /api/upload-zip?sessionId=...`
- `GET /api/download-zip?sessionId=...`
- `POST /api/terminal`
