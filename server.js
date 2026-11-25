import express from "express";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { GoogleGenAI, Modality, Type } from "@google/genai";
import { SCENARIOS } from "./prompts.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const LIVE_MODEL = process.env.LIVE_MODEL || "gemini-3.8-live";

const endCallTool = {
  name: "end_call",
  description: "Termine l'appel simulé, après que le personnage a dit au revoir.",
  parameters: {
    type: Type.OBJECT,
    properties: { reason: { type: Type.STRING, description: "Motif court de fin d'appel." } },
    required: ["reason"],
  },
};

function safeSend(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

const app = express();
app.get("/api/health", (_req, res) => res.json({ ok: true, model: LIVE_MODEL, keyConfigured: Boolean(process.env.GEMINI_API_KEY) }));
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  const { pathname } = new URL(request.url ?? "/", `http://${request.headers.host}`);
  if (pathname === "/api/live") {
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
  } else {
    socket.destroy();
  }
});

wss.on("connection", async (clientWs, request) => {
  const url = new URL(request.url ?? "/api/live", `http://${request.headers.host}`);
  const scn = SCENARIOS.find((s) => s.id === Number(url.searchParams.get("scenario")));
  if (!scn) {
    safeSend(clientWs, { type: "error", message: "Scénario inconnu." });
    return clientWs.close(1008, "bad scenario");
  }
  if (!process.env.GEMINI_API_KEY) {
    safeSend(clientWs, { type: "error", message: "Clé API Gemini manquante côté serveur (variable GEMINI_API_KEY)." });
    return clientWs.close(1011, "no key");
  }

  let session = null;
  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    try { session?.close(); } catch { /* ignore */ }
    session = null;
  };

  try {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, apiVersion: "v1beta" });
    session = await ai.live.connect({
      model: LIVE_MODEL,
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: scn.voice } } },
        tools: [{ functionDeclarations: [endCallTool] }],
        systemInstruction: scn.prompt,
      },
      callbacks: {
        onopen: () => {
          console.log(`[live] scénario ${scn.id} connecté (${LIVE_MODEL}, ${scn.voice})`);
          safeSend(clientWs, { type: "ready" });
        },
        onmessage: (message) => {
          if (closed) return;
          const content = message.serverContent;
          for (const part of content?.modelTurn?.parts ?? []) {
            if (part.inlineData?.data) safeSend(clientWs, { type: "audio", data: part.inlineData.data });
          }
          if (content?.interrupted) safeSend(clientWs, { type: "interrupted" });
          for (const call of message.toolCall?.functionCalls ?? []) {
            if (call.name === "end_call") {
              try {
                session?.sendToolResponse({ functionResponses: [{ id: call.id, name: call.name, response: { status: "call_ended" } }] });
              } catch { /* ignore */ }
              const reason = typeof call.args?.reason === "string" ? call.args.reason : "";
              console.log(`[live] scénario ${scn.id} : l'appelant raccroche (motif : ${reason || "aucun"})`);
              safeSend(clientWs, { type: "callerHangup", reason });
            }
          }
        },
        onerror: (err) => {
          const detail = err?.error?.message || err?.message || String(err);
          console.error("[live] erreur Gemini:", detail);
          safeSend(clientWs, { type: "error", message: detail });
        },
        onclose: (ev) => {
          console.log("[live] session Gemini fermée", { code: ev?.code, reason: ev?.reason });
          if (!closed) {
            safeSend(clientWs, { type: "sessionClosed", code: ev?.code, reason: ev?.reason || "" });
            cleanup();
          }
        },
      },
    });

    // L'appelant parle en premier dès que l'apprenant décroche.
    session.sendClientContent({ turns: [{ role: "user", parts: [{ text: scn.opener }] }], turnComplete: true });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Impossible de démarrer la session vocale.";
    console.error("[live] échec de démarrage:", detail);
    safeSend(clientWs, { type: "error", message: detail });
    clientWs.close(1011, detail.slice(0, 120));
    cleanup();
    return;
  }

  clientWs.on("message", (raw) => {
    if (closed || !session) return;
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "audio" && typeof msg.data === "string") {
        session.sendRealtimeInput({ audio: { data: msg.data, mimeType: "audio/pcm;rate=16000" } });
      } else if (msg.type === "timeoutWarning") {
        session.sendClientContent({
          turns: [{ role: "user", parts: [{ text: "[Régie : 2 minutes 45 écoulées. Conclus l'appel poliment, dans ton personnage, maintenant.]" }] }],
          turnComplete: true,
        });
      } else if (msg.type === "hangup") {
        cleanup();
      }
    } catch (err) {
      console.error("[live] message client illisible:", err);
    }
  });
  clientWs.on("close", cleanup);
  clientWs.on("error", cleanup);
});

server.listen(PORT, "0.0.0.0", () => console.log(`Phishing ou pas ? sur http://0.0.0.0:${PORT}`));
