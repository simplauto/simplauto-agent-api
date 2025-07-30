# API Simplauto - Remboursements Automatiques

API webhook simple pour déclencher des appels IA automatiques de demandes de remboursement via ElevenLabs.

## Fonctionnement

1. **Webhook** reçoit le JSON Simplauto
2. **Validation** des données requises
3. **Normalisation** du numéro de téléphone français (+33)
4. **Appel immédiat** de l'agent IA ElevenLabs

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
PORT=3001
AI_AGENT_ID=agent_3601k1d905x7e78t8dx6dvzdyk5v
AI_AGENT_API_URL=https://api.elevenlabs.io/v1/convai/sip-trunk/outbound-call
ELEVENLABS_API_KEY=sk_your_key_here
AGENT_PHONE_NUMBER=+33977555287
AGENT_PHONE_NUMBER_ID=phnum_your_id_here
```

## Utilisation

### Webhook Principal

**POST** `/api/webhook/refund-request`

```json
{
  "booking": {
    "date": "31/07/2025 à 08h30"
  },
  "order": {
    "reference": "HZ85WEQH"
  },
  "customer": {
    "first_name": "Maeva",
    "last_name": "Kouvibidila"
  },
  "vehicule": {
    "brand": "",
    "model": "",
    "registration_number": ""
  },
  "center": {
    "phone": "0688358752",
    "name": "Centre Contrôle"
  }
}
```

### Variables Envoyées à l'Agent

L'agent ElevenLabs reçoit ces variables dynamiques :

- `{{nom_client}}` : "Maeva Kouvibidila"
- `{{date_reservation}}` : "31/07/2025 à 08h30"
- `{{marque_vehicule}}` : "non renseignée" (si vide)
- `{{modele_vehicule}}` : "non renseigné" (si vide)
- `{{immatriculation}}` : "non renseignée" (si vide)
- `{{reference}}` : "HZ85WEQH"

### Normalisation Téléphone

Tous les formats français sont normalisés :
- `0688358752` → `+33688358752`
- `06 88 35 87 52` → `+33688358752`
- `06.88.35.87.52` → `+33688358752`

## Endpoints

- `POST /api/webhook/refund-request` - Webhook principal
- `GET /api/health` - Health check + infos agent

## Architecture

```
src/
├── server.js         # Serveur principal + webhook
├── aiAgentClient.js  # Client ElevenLabs
└── phoneUtils.js     # Utils téléphone français
```

Simple, efficace, sans base de données.