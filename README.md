# API Simplauto - Remboursements Automatiques

API webhook intelligente pour automatiser les demandes de remboursement avec ElevenLabs AI Agent, intégration Crisp et résumé IA des motifs clients.

## Fonctionnement

1. **Webhook** reçoit le JSON Simplauto avec données client
2. **Intégration Crisp** : Recherche automatique des conversations client par email
3. **Résumé IA** : Claude analyse et extrait le motif de remboursement depuis Crisp
4. **Validation** des données requises
5. **Normalisation** du numéro de téléphone français (+33)
6. **Appel personnalisé** : L'agent IA ElevenLabs utilise l'explication du client
7. **Webhook Tool** : Validation en temps réel pendant l'appel
8. **Callback Make.com** : Retour automatique des résultats

## Installation

```bash
npm install
cp .env.example .env
# Configurer les variables dans .env
npm start
```

## Configuration

Variables d'environnement requises dans `.env` :

```env
# Configuration serveur
PORT=3001

# Configuration ElevenLabs
AI_AGENT_ID=agent_3601k1d905x7e78t8dx6dvzdyk5v
AI_AGENT_API_URL=https://api.elevenlabs.io/v1/convai/twilio/outbound-call
ELEVENLABS_API_KEY=sk_your_key_here
AGENT_PHONE_NUMBER=+33977555287
AGENT_PHONE_NUMBER_ID=phnum_your_id_here
ELEVENLABS_WEBHOOK_SECRET=wsec_your_secret_here

# Configuration Crisp (pour récupérer les explications clients)
CRISP_IDENTIFIER=your_crisp_identifier
CRISP_KEY=your_crisp_key  
CRISP_WEBSITE_ID=your_website_id

# Configuration Claude AI (pour résumer les motifs de remboursement)
CLAUDE_API_KEY=sk-ant-your_claude_key
```

## Utilisation

### Webhook Principal

**POST** `/api/webhook/refund-request`

```json
{
  "booking": {
    "date": "2025-07-28T15:30:00Z",
    "backoffice_url": "https://www.simplauto.com/backoffice/reservations/b8f9unqy-alexandre-senra/"
  },
  "order": {
    "reference": "B8F9UNQY"
  },
  "customer": {
    "first_name": "Alexandre",
    "last_name": "Senra Magalhaes",
    "email": "alexandremagalhaes@sapo.pt",
    "phone": "0766447890"
  },
  "vehicule": {
    "brand": "Audi",
    "model": "A5", 
    "registration_number": "DL-401-WK"
  },
  "center": {
    "phone": "0688358752"
  }
}
```

**Champs optionnels mais recommandés :**
- `customer.email` : Permet l'intégration Crisp pour récupérer l'explication du client
- `customer.phone` : Numéro de téléphone du client (normalisé automatiquement)

Quand `customer.email` est présent, le système :
1. Recherche automatiquement les conversations Crisp de ce client
2. Extrait avec Claude AI le motif de remboursement expliqué par le client  
3. Transmet cette explication personnalisée à l'agent ElevenLabs

### Variables Envoyées à l'Agent

L'agent ElevenLabs reçoit ces variables dynamiques :

- `{{nom_client}}` : "Alexandre Senra Magalhaes"
- `{{date_reservation}}` : "2025-07-28T15:30:00Z"
- `{{marque_vehicule}}` : "Audi" (ou "non renseignée" si vide)
- `{{modele_vehicule}}` : "A5" (ou "non renseigné" si vide)  
- `{{immatriculation}}` : "DL-401-WK" (ou "non renseignée" si vide)
- `{{reference}}` : "B8F9UNQY"
- `{{backoffice_url}}` : URL du backoffice Simplauto
- `{{telephone_client}}` : **NOUVEAU** - "+33766447890" (numéro client normalisé)
- `{{explication_client}}` : **NOUVEAU** - Motif de remboursement extrait par IA depuis Crisp

**Exemple d'utilisation dans le prompt ElevenLabs :**
```
Bonjour, je vous appelle concernant {{nom_client}}{{#if telephone_client}} au {{telephone_client}}{{/if}}, 
qui avait un rendez-vous le {{date_reservation}}.

{{#if explication_client}}
Le client nous a expliqué que : {{explication_client}}
{{/if}}

Pouvez-vous valider cette demande de remboursement ?
```

### Normalisation Téléphone

Tous les formats français sont automatiquement normalisés (centre ET client) :
- `0688358752` → `+33688358752`
- `06 88 35 87 52` → `+33688358752`
- `06.88.35.87.52` → `+33688358752`
- `0766447890` → `+33766447890`

## Endpoints

### Webhooks Principal
- `POST /api/webhook/refund-request` - Webhook principal pour initier les appels

### Webhook Tool ElevenLabs  
- `POST /api/tools/validation-remboursement` - Endpoint appelé par l'agent ElevenLabs pendant l'appel
- `GET /api/tools/validation-remboursement` - Documentation du webhook tool

### Post-call Webhook
- `POST /api/webhook/post-call` - Webhook ElevenLabs de fin d'appel (avec signature HMAC)

### Utilitaires
- `GET /api/health` - Health check + infos agent
- `GET /api/debug/conversations` - Debug des conversations actives  
- `GET /api/webhook/conversation/:id/status` - Statut d'une conversation

### Tests et Debug
- `POST /api/test/webhook` - Simuler webhook sans appel réel
- `POST /api/test/call-result/:id` - Simuler résultat d'appel
- `POST /api/test/scenarios` - Scénarios prédéfinis (callback_loop, technical_failures, mixed_results)

> 📖 **Guide complet des tests :** Voir [TESTING.md](./TESTING.md) pour tous les détails

### Integration Make.com
- Callback automatique vers `https://hook.eu1.make.com/nsdyueym7xwbj1waaia3jrbjolanjelu`
- Format de retour :
```json
{
  "booking": { "backoffice_url": "..." },
  "order": { "reference": "..." },
  "call_result": {
    "call_status": "answered|no_answer|voicemail|failed",
    "refund_response": {
      "status": "Accepté|Refusé|En attente de rappel",
      "reason": "motif du refus si applicable"
    }
  }
}
```

## Architecture

```
src/
├── server.js         # Serveur principal + tous les webhooks + intégrations
├── aiAgentClient.js  # Client ElevenLabs avec variables dynamiques
└── phoneUtils.js     # Normalisation téléphones français
```

## Flux Complet

1. **Webhook Simplauto** → `/api/webhook/refund-request`
2. **Recherche Crisp** → Conversations client par email (si fourni)
3. **Analyse Claude** → Extraction du motif de remboursement
4. **Appel ElevenLabs** → Agent avec variables personnalisées
5. **Webhook Tool** → `/api/tools/validation-remboursement` (pendant l'appel)
6. **Post-call Webhook** → `/api/webhook/post-call` (fin d'appel)
7. **Callback Make.com** → Résultats vers Make.com

## Intégrations

- **ElevenLabs** : Conversational AI avec webhook tools
- **Crisp** : Support client pour récupérer les conversations
- **Claude (Anthropic)** : IA pour résumer les motifs de remboursement  
- **Make.com** : Workflow automation pour traiter les résultats

Simple, intelligent, entièrement automatisé.

## Tests et Validation

### Tests Unitaires

Le projet inclut une suite de tests complète pour valider la logique métier :

```bash
# Lancer tous les tests
npm test

# Mode watch (redémarre automatiquement)
npm run test:watch

# Rapport de couverture
npm run test:coverage
```

**Tests inclus :**
- **businessHours.test.js** : Logique horaires français (9h-12h, 14h-17h)
- **queueManager.test.js** : File d'attente, rappels, retry
- **integration.test.js** : Workflow complet end-to-end

### Endpoints de Test (Sans Appels Réels)

Pour tester le système sans faire de vrais appels téléphoniques :

#### 1. Test Webhook Basique

```bash
curl -X POST "https://simplauto-agent-api-production2.up.railway.app/api/test/webhook" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@example.com",
    "phone": "0123456789",
    "force_queue": true
  }'
```

**Réponse :**
```json
{
  "success": true,
  "message": "Test - Demande ajoutée à la file d'attente",
  "queue_id": "uuid-1234",
  "scheduled_for": "2025-07-29T09:00:00Z",
  "test_mode": true
}
```

#### 2. Simuler un Résultat d'Appel

```bash
curl -X POST "https://simplauto-agent-api-production2.up.railway.app/api/test/call-result/uuid-1234" \
  -H "Content-Type: application/json" \
  -d '{
    "result": "En attente de rappel",
    "call_status": "answered",
    "reason": "Centre occupé"
  }'
```

**Résultats possibles :**
- `"Accepté"` : Remboursement accordé ✅
- `"Refusé"` : Remboursement refusé ❌
- `"En attente de rappel"` : Centre demande rappel 🔄
- `"no_answer"` : Pas de réponse 📞
- `"voicemail"` : Messagerie vocale 📧
- `"failed"` : Erreur technique ⚠️

#### 3. Scénarios de Test Automatiques

```bash
# Boucle de 3 rappels jusqu'à échec
curl -X POST "https://simplauto-agent-api-production2.up.railway.app/api/test/scenarios" \
  -H "Content-Type: application/json" \
  -d '{"scenario": "callback_loop"}'

# 3 échecs techniques successifs
curl -X POST "https://simplauto-agent-api-production2.up.railway.app/api/test/scenarios" \
  -H "Content-Type: application/json" \
  -d '{"scenario": "technical_failures"}'

# Résultats mixtes (accepté, refusé, callback)
curl -X POST "https://simplauto-agent-api-production2.up.railway.app/api/test/scenarios" \
  -H "Content-Type: application/json" \
  -d '{"scenario": "mixed_results"}'
```

### Monitoring de la File d'Attente

```bash
# Statut général
curl "https://simplauto-agent-api-production2.up.railway.app/api/queue/status"

# Prochaine heure d'ouverture
curl "https://simplauto-agent-api-production2.up.railway.app/api/queue/next-business-hours"

# Forcer le traitement (debug)
curl -X POST "https://simplauto-agent-api-production2.up.railway.app/api/queue/process"
```

### Exemple de Workflow de Test Complet

1. **Ajouter une demande hors horaires :**
```bash
curl -X POST ".../api/test/webhook" -d '{"force_queue": true}'
# → Retourne queue_id
```

2. **Vérifier le statut :**
```bash
curl ".../api/queue/status"
# → pending: 1
```

3. **Simuler un callback :**
```bash
curl -X POST ".../api/test/call-result/QUEUE_ID" -d '{"result": "En attente de rappel"}'
# → status: "rescheduled", next_attempt: "..."
```

4. **Répéter jusqu'à résolution :**
```bash
curl -X POST ".../api/test/call-result/NEW_QUEUE_ID" -d '{"result": "Accepté"}'
# → status: "completed"
```

### Validation des Horaires

Le système respecte automatiquement les horaires français :
- **Lundi à Vendredi** : 9h-12h et 14h-17h (Europe/Paris)
- **Weekend** : Aucun traitement
- **Hors horaires** : Mise en file d'attente automatique