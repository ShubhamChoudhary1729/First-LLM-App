import { NextRequest, NextResponse } from "next/server";

// ─── Model config ─────────────────────────────────────────────────────────────
// The client can request any model in ALLOWED_MODELS.
// If it sends an unknown name (or nothing), we fall back to DEFAULT_MODEL.
const DEFAULT_MODEL = "gemini-3.8-flash";
const ALLOWED_MODELS = new Set([
  "gemini-2.5-flash",
  "gemini-2.5-pro",
  "gemini-3.5-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.6-flash",
  "gemini-3.7-flash",
  "gemini-3.8-flash",
]);

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";

// ─── System instruction ───────────────────────────────────────────────────────
// Edit the text below to change how the assistant behaves.
// This is sent to Gemini as a system-level prompt, separate from the conversation
// history, so it applies to every reply without appearing in the chat.
const SYSTEM_INSTRUCTION =
  "Answer only the exact question asked. No greetings, no extra context. Maximum 2 sentences."
// ─── Retry config ─────────────────────────────────────────────────────────────
// On a 503 (model overloaded), retry before surfacing an error.
// Retries only happen before the stream starts, so they are always safe.
const MAX_RETRIES = 2;     // up to 2 retries = 3 total attempts
const RETRY_BASE_MS = 600; // 600 ms → 1 200 ms on the second retry

type ClientMessage = {
  role: "user" | "assistant";
  content: string;
};

type GeminiTurn = {
  role: "user" | "model"; // Gemini uses "model", not "assistant"
  parts: { text: string }[];
};

export async function POST(req: NextRequest) {
  try {
    // 1. Parse the incoming request body
    const body = await req.json();
    const messages: ClientMessage[] | undefined = body?.messages;

    if (!Array.isArray(messages) || messages.length === 0) {
      return NextResponse.json(
        { error: "Request body must include a non-empty `messages` array." },
        { status: 400 }
      );
    }
    const lastMsg = messages[messages.length - 1];
    if (lastMsg.role !== "user" || !lastMsg.content?.trim()) {
      return NextResponse.json(
        { error: "The last message in `messages` must be a non-empty user message." },
        { status: 400 }
      );
    }

    // 2. Resolve the model — validate against allowlist so arbitrary strings can't be injected
    const requestedModel: string | undefined = body?.model;
    const model =
      requestedModel && ALLOWED_MODELS.has(requestedModel)
        ? requestedModel
        : DEFAULT_MODEL;

    // streamGenerateContent + ?alt=sse → Gemini sends SSE chunks instead of one big JSON blob
    const geminiApiUrl = `${GEMINI_BASE_URL}/${model}:streamGenerateContent`;

    // 3. Ensure the API key exists — server-side only, never sent to the browser
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "GEMINI_API_KEY is not configured on the server." },
        { status: 500 }
      );
    }

    // 4. Convert client message format → Gemini's contents format
    //    ("assistant" → "model" because that's what Gemini expects)
    const contents: GeminiTurn[] = messages.map((msg) => ({
      role: msg.role === "assistant" ? "model" : "user",
      parts: [{ text: msg.content }],
    }));

    // 5. Call Gemini — retry on 503 (transient overload) before the stream starts.
    //    This is safe because no bytes have been sent to the client yet.
    let geminiResponse!: Response;
    let lastErrorBody = "";

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const waitMs = RETRY_BASE_MS * attempt;
        console.warn(`Gemini 503 — retrying in ${waitMs} ms (attempt ${attempt + 1})`);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }

      geminiResponse = await fetch(`${geminiApiUrl}?alt=sse&key=${apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // System instruction — edit SYSTEM_INSTRUCTION at the top of this file
          systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
          contents,
        }),
      });

      // Stop retrying on success or on any error other than 503
      if (geminiResponse.ok || geminiResponse.status !== 503) break;

      // 503: read the body (consuming it is required before retrying)
      lastErrorBody = await geminiResponse.text();
      console.error("Gemini 503 body:", lastErrorBody);
    }

    // 6. Handle non-OK responses — returned as JSON, not streams
    if (!geminiResponse.ok) {
      const errorBody = lastErrorBody || (await geminiResponse.text());
      console.error("Gemini API error:", geminiResponse.status, errorBody);

      // 429 = daily free-tier quota exhausted for this model
      if (geminiResponse.status === 429) {
        return NextResponse.json(
          {
            // User-facing: friendly tone. Full technical detail is in console.error above.
            error:
              "I'm getting a lot of requests right now — the free-tier limit for this model " +
              "has been reached for today. Try switching to a different model, or come back tomorrow!",
            quotaExhausted: true,
            model,
          },
          { status: 429 }
        );
      }

      // 503 = model overloaded even after retries — tell the user to try again or switch models
      if (geminiResponse.status === 503) {
        return NextResponse.json(
          {
            error:
              "This model is under heavy demand right now. " +
              "Please try again in a moment, or switch to a different model from the dropdown.",
          },
          { status: 503 }
        );
      }

      return NextResponse.json(
        { error: `Gemini API returned ${geminiResponse.status}: ${errorBody}` },
        { status: 502 }
      );
    }

    if (!geminiResponse.body) {
      return NextResponse.json(
        { error: "Gemini returned no response body." },
        { status: 502 }
      );
    }

    // 7. Stream Gemini's SSE response to the client.
    //
    //    Gemini emits lines like:
    //      data: {"candidates":[{"content":{"parts":[{"text":"Hello"}],"role":"model"}}]}
    //
    //    We parse each chunk, extract the text, and forward simplified events:
    //      data: {"text":"Hello"}          ← one per token/chunk
    //      data: {"done":true,"model":"…"} ← final event (for client-side usage tracking)
    //
    //    Errors or non-OK responses are returned as plain JSON above, so by the
    //    time we reach this point the stream is guaranteed to be valid.
    const encoder = new TextEncoder();
    const geminiReader = geminiResponse.body.getReader();

    const stream = new ReadableStream({
      async start(controller) {
        const decoder = new TextDecoder();
        let buffer = "";

        try {
          while (true) {
            const { done, value } = await geminiReader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? ""; // keep the incomplete last line in the buffer

            for (const line of lines) {
              if (!line.startsWith("data: ")) continue;
              const jsonStr = line.slice(6).trim();
              if (!jsonStr || jsonStr === "[DONE]") continue;

              try {
                const chunk = JSON.parse(jsonStr);
                const text: string | undefined =
                  chunk?.candidates?.[0]?.content?.parts?.[0]?.text;
                if (text) {
                  controller.enqueue(
                    encoder.encode(`data: ${JSON.stringify({ text })}\n\n`)
                  );
                }
              } catch {
                /* skip malformed JSON chunks — Gemini occasionally emits keep-alives */
              }
            }
          }

          // Completion event — client uses this to trigger usage tracking
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ done: true, model })}\n\n`)
          );
        } catch (err) {
          console.error("Streaming error:", err);
          controller.error(err);
        } finally {
          controller.close();
        }
      },
      cancel() {
        // User navigated away or closed the connection — abort the upstream fetch
        geminiReader.cancel();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no", // tell nginx/proxies not to buffer the stream
      },
    });
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "An unexpected error occurred.";
    console.error("POST /api/chat error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
