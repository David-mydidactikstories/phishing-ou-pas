import express from "express";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { GoogleGenAI, Modality, Type, StartSensitivity, EndSensitivity } from "@google/genai";
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

// Agents ElevenLabs (un par scénario). Surchargeables par variables d'environnement.
const EL_AGENTS = {
  1: process.env.EL_AGENT_1 || "agent_0701m89t8qjceyha265js2wxez4e", // Thomas (banque)
  2: process.env.EL_AGENT_2 || "agent_5401m89weyzqffssxx2r5vfkvs28", // Julien (IT)
  3: process.env.EL_AGENT_3 || "agent_9301m89wf1daf50vtpnxkeah4am2", // Marc Delvaux
  4: process.env.EL_AGENT_4 || "agent_7001m89wf3d3ee58fzfvx2g2wdnx", // Stéphanie (colis)
};

const app = express();
app.get("/api/health", (_req, res) =>
  res.json({
    ok: true,
    engine: process.env.ELEVENLABS_API_KEY ? "elevenlabs" : "gemini",
    elevenlabsKey: Boolean(process.env.ELEVENLABS_API_KEY),
    geminiKey: Boolean(process.env.GEMINI_API_KEY),
    model: LIVE_MODEL,
  }),
);
app.get("/api/config", (_req, res) =>
  res.json({
    elevenlabs: Boolean(process.env.ELEVENLABS_API_KEY),
    gemini: Boolean(process.env.GEMINI_API_KEY),
  }),
);
// URL signée ElevenLabs : la clé API reste côté serveur, le navigateur se connecte directement.
app.get("/api/el-session", async (req, res) => {
  const agentId = EL_AGENTS[Number(req.query.scenario)];
  if (!agentId) return res.status(400).json({ error: "Scénario inconnu." });
  if (!process.env.ELEVENLABS_API_KEY) return res.status(503).json({ error: "Clé ElevenLabs manquante côté serveur (variable ELEVENLABS_API_KEY)." });
  try {
    const r = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}`,
      { headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY } },
    );
    if (!r.ok) {
      const body = await r.text();
      console.error("[el] signed url", r.status, body.slice(0, 200));
      return res.status(502).json({ error: `ElevenLabs a refusé la connexion (${r.status}).` });
    }
    const data = await r.json();
    res.json({ signedUrl: data.signed_url });
  } catch (err) {
    console.error("[el] signed url", err);
    res.status(502).json({ error: "Impossible de joindre ElevenLabs." });
  }
});
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

  // Prénom saisi avant l'appel (secours Gemini) : remplace Bertille / Berty dans le prompt.
  const clean = (v, d) => (String(v || "").replace(/[^\p{L}\- ']/gu, "").trim().slice(0, 30) || d);
  const prenom = clean(url.searchParams.get("prenom"), "Bertille");
  const prenomDit = clean(url.searchParams.get("prenom_dit"), prenom === "Bertille" ? "Berty" : prenom);
  const personalize = (t) => t.replaceAll("Bertille", prenom).replaceAll("Berty", prenomDit);

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
        // Détection de la voix plus réactive : les réponses courtes (« oui », « c'est moi ») sont captées du premier coup.
        realtimeInputConfig: {
          automaticActivityDetection: {
            startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_HIGH,
            endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_HIGH,
            prefixPaddingMs: 150,
            silenceDurationMs: 450,
          },
        },
        systemInstruction: personalize(scn.prompt),
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
