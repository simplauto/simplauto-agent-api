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
    "email": "alexandremagalhaes@sapo.pt"
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

**Nouveauté** : Le champ `customer.email` est optionnel mais **fortement recommandé**. Quand présent, le système :
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
- `{{explication_client}}` : **NOUVEAU** - Motif de remboursement extrait par IA depuis Crisp

**Exemple d'utilisation dans le prompt ElevenLabs :**
```
{{#if explication_client}}
Le client a expliqué que : {{explication_client}}
{{/if}}
```

### Normalisation Téléphone

Tous les formats français sont normalisés :
- `0688358752` → `+33688358752`
- `06 88 35 87 52` → `+33688358752`
- `06.88.35.87.52` → `+33688358752`

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