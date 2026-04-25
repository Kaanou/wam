# WA Presence Monitor — PRD

## Original Problem Statement
> Créer une webpage accessible depuis internet qui permet de vérifier la connexion en ligne sur WhatsApp d'un numéro et l'enregistre avec date et heure précise sous forme de log. Interface simple : on demande un numéro au format international, on vérifie si le contact se connecte à WhatsApp, on enregistre l'info et on envoie une notification en direct. Pareil quand il se déconnecte.

## User Choices
- Approche technique : **whatsapp-web.js** (option 1a) — sidecar Node.js, QR pairing requis (l'utilisateur a confirmé malgré le risque de bannissement WhatsApp)
- Notifications : **navigateur + email** (email à choix dans l'UI)
- Authentification : **aucune** (page publique)
- Historique : **oui** (table des logs avec date/heure précise)
- Email provider : **Resend** — clé fournie

## Architecture
```
┌────────────────┐  WebSocket /api/ws  ┌────────────────┐  HTTP  ┌──────────────────────┐
│ React frontend │◀───────────────────▶│  FastAPI :8001 │◀──────▶│ Node :3001 (internal)│
│  (port 3000)   │      /api/*         │  (MongoDB)     │         │ whatsapp-web.js     │
└────────────────┘                     └────────────────┘         └──────────────────────┘
                                                                      ▲ QR pairing via UI
```
- **whatsapp-service** (Node, supervisor program) : whatsapp-web.js + LocalAuth, presence subscription + 12 s polling fallback, push events to FastAPI via `/api/internal/event`
- **backend** (FastAPI) : proxy + persistence (`monitors`, `events`, `settings`), WS broadcast, Resend email
- **frontend** (React + shadcn) : QR pairing → add number → live monitors → activity log

## Implemented (2026-04-25)
- Node sidecar with whatsapp-web.js, QR generation, presence event listening + polling fallback
- FastAPI endpoints : `/api/whatsapp/{status,qr,logout}`, `/api/monitors` (CRUD), `/api/events`, `/api/settings`, `/api/internal/event` (webhook), `/api/ws` (WebSocket)
- MongoDB collections : `monitors`, `events`, `settings`
- Resend email notifications (HTML template, threaded send)
- Browser Notification API integration
- React UI : observability/control-room dark theme (zinc-950 + JetBrains Mono + Chivo), QR pairing panel, add monitor form, live monitors list with pulse dots, activity feed/log table with row-flash on live events, email settings panel
- Supervisor config for the Node sidecar (`/etc/supervisor/conf.d/whatsapp_service.conf`)
- 15/15 backend tests passing

## Backlog (P1)
- Shared-secret auth on `/api/internal/event` (currently exposed via ingress)
- Verify a custom domain in Resend so emails can go to any recipient (mode test = vérifié seulement)
- Make Node service handle Chrome crashes/auto-restart with backoff
- Allow alias/label per monitored number

## Backlog (P2)
- Daily/weekly summary email
- Stats : online time per contact, longest session, average gap
- Dark/light theme toggle
- Multi-account WhatsApp pairing
- CSV export of logs
- Filtering & search in the activity log

## Known Constraints / Risks
- whatsapp-web.js viole les CGU WhatsApp → risque de bannissement du compte qui scanne le QR (l'utilisateur en a été averti et a confirmé)
- Présence visible uniquement si le contact n'a pas restreint sa "vue dernière connexion" en privacy WhatsApp
- Resend en mode test : seules les adresses vérifiées reçoivent les mails. Vérifier un domaine pour envoyer librement.

## Test Credentials
- n/a (pas d'auth)

## Files
- `/app/whatsapp-service/server.js` — Node sidecar
- `/app/backend/server.py` — FastAPI app
- `/app/frontend/src/App.js` — React UI
- `/etc/supervisor/conf.d/whatsapp_service.conf` — supervisor program
