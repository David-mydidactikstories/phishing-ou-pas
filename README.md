# Phishing ou pas ?

Simulation d'appel vocal en direct pour l'atelier UCM (14 décembre 2026).
Quatre appels en numéro masqué ; l'apprenant saisit son prénom, décroche, questionne, puis décide de donner ou non l'information.
Le verdict (hacker / légitime) est écrit en dur dans `public/index.html`, jamais décidé par l'IA.

- `server.js` : URL signée ElevenLabs (`/api/el-session`) + pont WebSocket Gemini Live de secours (`/api/live`)
- `public/el.js` : voix via les agents ElevenLabs (moteur principal) ; `public/live.js` : voix Gemini (secours)
- `prompts.js` : prompts Gemini de secours. Les prompts ElevenLabs vivent dans les 4 agents ElevenLabs.
- Le motif de fin d'appel (obtenu / abandon / rappel / timeout) arrive par l'outil client `fin_appel` des agents.

## Lancer

    npm install
    ELEVENLABS_API_KEY=... npm start

Moteur : ElevenLabs si `ELEVENLABS_API_KEY` est définie, sinon Gemini (`GEMINI_API_KEY`). `?engine=gemini` force le secours.
Le micro exige https (ou localhost).
