// AI-suggested call sentiment: transcribes a call recording (Groq Whisper) and classifies
// tone (Gemini), triggered on-demand by a manager from Call Audit — not automatic on every
// call. Writes via the service-role client since call_logs has no general UPDATE policy (see
// 20260814_call_logs_ai_sentiment.sql); verifyCaller() enforces manager/admin + same-client
// scoping server-side rather than trusting anything the browser sends.
import { z, tokenSchema, idSchema } from "./schemas";
import { createServerFn } from "@tanstack/react-start";
import { getSupabaseAdmin, verifyCaller } from "./supabase-admin.server";
import { fetchPublicBlob } from "./safe-fetch.server";

const SENTIMENT_LABELS = ["happy", "neutral", "frustrated", "rude"] as const;
type SentimentLabel = (typeof SENTIMENT_LABELS)[number];

interface AiSentimentResult {
  agent_tone: SentimentLabel;
  debtor_tone: SentimentLabel;
  overall_call_sentiment: SentimentLabel;
  confidence: number;
  reasoning: string;
}

const SYSTEM_PROMPT = `You analyze debt-collection call transcripts and classify the tone of \
each speaker. Transcripts may mix Hindi, English, and Marathi (code-switched) - read them in \
whatever language they're in.

Classify BOTH the agent's tone and the debtor's tone separately, using ONLY one of these \
labels: ${SENTIMENT_LABELS.join(", ")}.

Respond with ONLY valid JSON, no other text, in this exact shape:
{
  "agent_tone": "<label>",
  "debtor_tone": "<label>",
  "overall_call_sentiment": "<label>",
  "confidence": <0-1 float>,
  "reasoning": "<one or two sentence explanation, citing specific phrases from the transcript>"
}`;

async function transcribeWithGroq(audioBlob: Blob): Promise<string> {
  const form = new FormData();
  form.append("file", audioBlob, "recording.mp3");
  form.append("model", "whisper-large-v3");
  form.append("response_format", "verbose_json");

  const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Groq transcription failed: ${await res.text()}`);
  const json = (await res.json()) as { text: string };
  return json.text;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Gemini's free tier occasionally returns a transient 503 "high demand" error even on a
// valid request - confirmed while testing this against a real recording. Retry with backoff
// rather than surfacing a spurious failure to the manager.
async function analyzeWithGemini(transcript: string, retries = 3): Promise<AiSentimentResult> {
  for (let attempt = 0; attempt < retries; attempt++) {
    const res = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent",
      {
        method: "POST",
        // Key in a header, not the URL: URLs end up in error messages and access logs.
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": process.env.GEMINI_API_KEY ?? "",
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [{ parts: [{ text: `Transcript:\n\n${transcript}` }] }],
          generationConfig: { maxOutputTokens: 2000, responseMimeType: "application/json" },
        }),
      },
    );
    if (res.status === 503 && attempt < retries - 1) {
      await sleep(2 ** attempt * 1000);
      continue;
    }
    if (!res.ok) throw new Error(`Gemini sentiment analysis failed: ${await res.text()}`);
    const json = await res.json();
    const text: string | undefined = json.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error("Gemini returned no content");
    return JSON.parse(text) as AiSentimentResult;
  }
  throw new Error("Gemini sentiment analysis failed after retries");
}

export const analyzeCallSentiment = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        callId: idSchema,
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await verifyCaller(data.accessToken);
    if (!caller) throw new Error("Not authenticated");
    if (caller.role !== "manager" && caller.role !== "admin") {
      throw new Error("Only managers or admins can run AI sentiment analysis");
    }

    const admin = getSupabaseAdmin();
    const { data: rawLog, error: logErr } = await admin
      .from("call_logs")
      .select("id, recording_url, debtors!inner(client_id)")
      .eq("id", data.callId)
      .single();
    if (logErr || !rawLog) throw new Error("Call log not found");
    // The generated Supabase types don't cover this table's columns (same as every other
    // store in this codebase), so the row widens to `never` - narrow to the shape we selected.
    const log = rawLog as unknown as {
      id: string;
      recording_url: string | null;
      debtors: { client_id: string };
    };
    if (log.debtors?.client_id !== caller.clientId) throw new Error("Not authorized for this call");
    if (!log.recording_url) throw new Error("No recording available for this call yet");

    // recording_url is user-writable, so it is fetched through the SSRF guard, never raw.
    const audioBlob = await fetchPublicBlob(log.recording_url);

    const transcript = await transcribeWithGroq(audioBlob);
    const sentiment = await analyzeWithGemini(transcript);

    const { error: updateErr } = await admin
      .from("call_logs")
      .update({
        ai_transcript: transcript,
        ai_agent_tone: sentiment.agent_tone,
        ai_debtor_tone: sentiment.debtor_tone,
        ai_sentiment: sentiment.overall_call_sentiment,
        ai_sentiment_confidence: sentiment.confidence,
        ai_sentiment_reasoning: sentiment.reasoning,
        ai_sentiment_analyzed_at: new Date().toISOString(),
      } as never)
      .eq("id", data.callId);
    if (updateErr) throw updateErr;

    return { transcript, ...sentiment };
  });
