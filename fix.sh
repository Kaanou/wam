#!/bin/bash
# ============================================================
# WA Monitor - Script de correction automatique
# Usage: bash fix.sh (depuis la racine du repo cloné)
# ============================================================

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log()  { echo -e "${GREEN}✓${NC} $1"; }
warn() { echo -e "${YELLOW}⚠${NC}  $1"; }
info() { echo -e "${BLUE}→${NC} $1"; }
err()  { echo -e "${RED}✗${NC} $1"; exit 1; }

echo ""
echo -e "${BLUE}╔══════════════════════════════════════╗${NC}"
echo -e "${BLUE}║   WA Monitor — Fix & Setup Script    ║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════╝${NC}"
echo ""

# Check we're in the right place
[ -f "backend/server.py" ] || err "Lance ce script depuis la racine du repo (où se trouvent backend/ et frontend/)"

# ── 1. .gitignore ──────────────────────────────────────────
info "Création du .gitignore..."
cat > .gitignore << 'GITIGNORE'
# Secrets — NE JAMAIS COMMITER
backend/.env
frontend/.env
whatsapp-service/.env
.env

# Session WhatsApp (~300MB, données sensibles)
.wwebjs_auth/
.wwebjs_cache/
whatsapp-service/.wwebjs_auth/
whatsapp-service/.wwebjs_cache/

# Dependencies
node_modules/
frontend/node_modules/
whatsapp-service/node_modules/

# Python
__pycache__/
*.pyc
*.pyo
.venv/
venv/
*.egg-info/

# Build
frontend/build/
dist/

# Logs
*.log
npm-debug.log*
yarn-debug.log*

# OS
.DS_Store
Thumbs.db
GITIGNORE
log ".gitignore créé"

# ── 2. backend/.env.example ──────────────────────────────
info "Création de backend/.env.example..."
cat > backend/.env.example << 'ENVEX'
MONGO_URL="mongodb://localhost:27017"
DB_NAME="wa_monitor"
CORS_ORIGINS="http://localhost:3000"
RESEND_API_KEY=""
SENDER_EMAIL="you@yourdomain.com"
WHATSAPP_SERVICE_URL="http://localhost:3001"
INTERNAL_API_SECRET="change-this-to-a-random-string"
ENVEX
log "backend/.env.example créé"

# ── 3. backend/.env (seulement si inexistant ou contient encore l'ancienne clé) ──
info "Vérification backend/.env..."
if [ ! -f "backend/.env" ]; then
  cp backend/.env.example backend/.env
  warn "backend/.env créé depuis l'exemple — configure RESEND_API_KEY et INTERNAL_API_SECRET"
else
  # Neutralise l'ancienne clé Resend exposée si elle est encore là
  if grep -q "re_WytFiajA" backend/.env 2>/dev/null; then
    sed -i 's/RESEND_API_KEY=.*/RESEND_API_KEY=""/' backend/.env
    warn "Ancienne clé Resend exposée neutralisée dans backend/.env — remplace-la par une nouvelle clé"
  fi
  # Fix CORS to not be wildcard
  sed -i 's/CORS_ORIGINS="\*"/CORS_ORIGINS="http:\/\/localhost:3000"/' backend/.env
  # Fix DB name
  sed -i 's/DB_NAME="test_database"/DB_NAME="wa_monitor"/' backend/.env
  log "backend/.env mis à jour"
fi

# ── 4. frontend/.env ─────────────────────────────────────
info "Correction frontend/.env..."
cat > frontend/.env << 'FRONTENV'
REACT_APP_BACKEND_URL=http://localhost:8001
WDS_SOCKET_PORT=3000
ENABLE_HEALTH_CHECK=false
FRONTENV
log "frontend/.env corrigé (URL localhost)"

# ── 5. frontend/src/utils.js ─────────────────────────────
info "Correction frontend/src/utils.js..."
cat > frontend/src/utils.js << 'UTILS'
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs) {
  return twMerge(clsx(inputs));
}
UTILS
log "utils.js corrigé"

# ── 6. frontend/src/use-toast.js ─────────────────────────
info "Correction frontend/src/use-toast.js..."
cat > frontend/src/use-toast.js << 'USETOAST'
export { toast } from "sonner";
USETOAST
log "use-toast.js corrigé"

# ── 7. Fix bug scientif. notation dans App.js ────────────
info "Correction des bugs dans App.js..."
# Fix scientific notation in phone example (3.3612345678e+10 → correct format)
sed -i 's/Format international (sans +), ex : 3.3612345678e+10/Format international sans +, ex : 41791234567/g' frontend/src/App.js
sed -i 's/Format international, ex : 3.3612345678e+10/Format international sans +, ex : 41791234567/g' frontend/src/App.js
# Fix BACKEND_URL fallback
sed -i 's/const BACKEND_URL = process.env.REACT_APP_BACKEND_URL;/const BACKEND_URL = process.env.REACT_APP_BACKEND_URL || "http:\/\/localhost:8001";/' frontend/src/App.js
log "App.js corrigé (notation, fallback URL)"

# ── 8. Supprimer dépendance Emergent de package.json ─────
info "Suppression de la dépendance Emergent..."
if [ -f "frontend/package.json" ]; then
  # Remove the emergentbase line from package.json
  sed -i '/@emergentbase\/visual-edits/d' frontend/package.json
  # Remove trailing comma issues (simple fix)
  # Use python for safer JSON handling
  python3 - << 'PYFIX'
import json, sys
with open("frontend/package.json", "r") as f:
    pkg = json.load(f)
dev = pkg.get("devDependencies", {})
removed = dev.pop("@emergentbase/visual-edits", None)
if removed:
    print(f"  Supprimé: @emergentbase/visual-edits")
with open("frontend/package.json", "w") as f:
    json.dump(pkg, f, indent=2, ensure_ascii=False)
    f.write("\n")
PYFIX
  log "Dépendance Emergent supprimée de package.json"
fi

# ── 9. Nettoyer les fichiers sensibles du tracking Git ──
info "Nettoyage Git (suppression des fichiers sensibles du tracking)..."
git rm -r --cached whatsapp-service/.wwebjs_auth/ 2>/dev/null && log ".wwebjs_auth retiré du tracking" || true
git rm -r --cached whatsapp-service/.wwebjs_cache/ 2>/dev/null && log ".wwebjs_cache retiré du tracking" || true
git rm --cached backend/.env 2>/dev/null && log "backend/.env retiré du tracking" || true
git rm --cached frontend/.env 2>/dev/null && log "frontend/.env retiré du tracking" || true

# ── 10. Commit et push ───────────────────────────────────
echo ""
info "Commit des corrections..."
git add .
git add -f backend/.env.example 2>/dev/null || true
git commit -m "fix: corrections sécurité, bugs et config locale

- .gitignore: exclusion .env, .wwebjs_auth, node_modules
- backend/.env: clé Resend neutralisée, CORS corrigé, DB renommée
- frontend/.env: URL backend → localhost:8001
- frontend/src/utils.js: fichier corrompu reconstruit
- frontend/src/use-toast.js: fichier corrompu reconstruit
- frontend/src/App.js: bug notation scientifique, fallback BACKEND_URL
- frontend/package.json: suppression dépendance Emergent
- backend/.env.example: template ajouté" 2>/dev/null || warn "Rien à commiter (déjà à jour)"

info "Push vers GitHub..."
git push && log "Push réussi ✓" || warn "Push échoué — vérifie tes credentials GitHub"

# ── 11. Résumé ───────────────────────────────────────────
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║           Corrections terminées !        ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════╝${NC}"
echo ""
echo "  Prochaines étapes pour lancer le projet :"
echo ""
echo "  1. Backend Python :"
echo "     cd backend"
echo "     python -m venv venv && source venv/bin/activate"
echo "     pip install -r requirements.txt"
echo "     uvicorn server:app --port 8001 --reload"
echo ""
echo "  2. Service WhatsApp :"
echo "     cd whatsapp-service"
echo "     yarn install && node server.js"
echo ""
echo "  3. Frontend React :"
echo "     cd frontend"
echo "     yarn install && yarn start"
echo ""
warn "N'oublie pas : configure RESEND_API_KEY dans backend/.env avec une NOUVELLE clé"
warn "L'ancienne clé (re_WytFiajA_...) est compromise — crée-en une nouvelle sur resend.com"
echo ""
