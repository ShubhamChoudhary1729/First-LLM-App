# Gemini Chat

A minimal full-stack AI chat app built with **Next.js 15** and the **Google Gemini API**.  
Replies stream in token-by-token, full conversation history is kept per session, and the model can be switched from the UI.

---

##                Features

- 🌊 Streaming replies (SSE) — words appear as they are generated
- 🧠 Conversation memory — full history sent with every request
- 🔄 Model switcher — change between Gemini Flash/Pro models in the header
- 📊 Daily quota tracker — shows remaining free-tier requests per model
- ✏️ Edit messages — hover any user bubble to edit and re-send
- 🔒 API key is server-side only — never exposed to the browser

---

## Prerequisites

- [Node.js](https://nodejs.org/) v18 or later
- A **Google Gemini API key** from [Google AI Studio](https://aistudio.google.com/app/apikey)  
  *(the key starts with `AIzaSy…`)*

---

## Running locally

### 1. Install dependencies

```bash
npm install
```

### 2. Set the API key

Create a file called **`.env.local`** in the project root (it is already in `.gitignore`):

```env
GEMINI_API_KEY=AIzaSy...your_key_here
```

> ⚠️ Never commit this file or share the key. It is read only by the server — the browser never sees it.

### 3. Start the dev server

```bash
npm run dev
```

Then open [http://localhost:3000](http://localhost:3000).

> **Windows with portable Node.js:** If `npm` is not on your PATH, use the included helper script:
> ```powershell
> Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass; .\dev.ps1
> ```

---

## Deploying to Vercel

1. Push the project to a GitHub / GitLab / Bitbucket repository.
2. Import the repository at [vercel.com/new](https://vercel.com/new).
3. In the **Environment Variables** section, add:

   | Name | Value |
   |------|-------|
   | `GEMINI_API_KEY` | `AIzaSy...your_key_here` |

4. Click **Deploy**. Vercel auto-detects Next.js — no extra configuration needed.

> **Note:** The free Gemini tier allows **20 requests/day per model**. The UI tracks this count per browser using `localStorage`. If you need higher limits, add a billing account in Google AI Studio.

---

## Project structure

```
app/
  api/chat/route.ts   # Server-side: calls Gemini, streams SSE back to client
  page.tsx            # Client-side: chat UI, streaming reader, usage tracker
  layout.tsx          # Root layout (Inter font)
public/
  api-test.html       # Standalone backend test page (open at /api-test.html)
.env.local            # Your API key — never committed
```

## Editing the assistant's personality

Open [`app/api/chat/route.ts`](./app/api/chat/route.ts) and edit the `SYSTEM_INSTRUCTION` constant near the top of the file:

```ts
export const SYSTEM_INSTRUCTION =
  "You are a friendly, concise general assistant. ...";
```

---

## Environment variables reference

| Variable | Required | Description |
|----------|----------|-------------|
| `GEMINI_API_KEY` | ✅ Yes | Google AI Studio API key. Server-side only. |
