# JEV Codex Pilot

- Le serveur API vit dans `src/api`, le moteur JEV dans `src/core` et l’interface dans `src/web`.
- JEV ne modifie jamais les fichiers du projet cible et ne lance aucun test du projet cible.
- L’exécution de Codex est volontairement opt-in via `POST /api/jobs/:id/run` ou le bouton d’exécution.
- La persistance locale de développement est écrite sous `.jev/`.
