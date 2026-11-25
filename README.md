# Phishing ou pas ?

Simulation d'appel vocal en direct pour l'atelier UCM (14 décembre 2026).
Trois appels en numéro masqué ; l'apprenant décroche, questionne, puis décide de donner ou non l'information.
Le verdict (hacker / légitime) est écrit en dur dans `public/index.html`, jamais décidé par l'IA.

- `server.js` : pont WebSocket entre le navigateur et Gemini Live (la clé reste côté serveur)
- `prompts.js` : les 3 « cerveaux » des avatars
- `public/` : la page, la sonnerie et le module voix

## Lancer

    npm install
    GEMINI_API_KEY=... npm start

Variable obligatoire : `GEMINI_API_KEY`. Optionnelle : `LIVE_MODEL`.
Le micro exige https (ou localhost).
