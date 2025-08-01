# Guide de Tests - API Simplauto

Ce guide explique comment tester le système de file d'attente et de rappels automatiques sans faire de vrais appels téléphoniques.

## Tests Automatisés

### Installation et Lancement

```bash
# Installer les dépendances (si pas déjà fait)
npm install

# Lancer tous les tests
npm test

# Mode développement (redémarre automatiquement)
npm run test:watch

# Rapport de couverture détaillé
npm run test:coverage
```

### Types de Tests

**1. Tests Unitaires (`__tests__/businessHours.test.js`)**
- Validation des horaires d'ouverture français
- Calcul des créneaux de rappel
- Délais de retry selon le type d'échec

**2. Tests de File d'Attente (`__tests__/queueManager.test.js`)**
- Ajout/suppression d'éléments
- Gestion des statuts et transitions
- Logique de rappels automatiques
- Nettoyage et archivage

**3. Tests d'Intégration (`__tests__/integration.test.js`)**
- Workflow complet de bout en bout
- Cohérence des données
- Calculs de délais réels

## Tests Manuels via API

### URL de Base

```
https://simplauto-agent-api-production2.up.railway.app
```

### 1. Test de Base - Ajouter une Demande

**Endpoint :** `POST /api/test/webhook`

```bash
curl -X POST "https://simplauto-agent-api-production2.up.railway.app/api/test/webhook" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@example.com",
    "phone": "0123456789",
    "force_queue": true
  }'
```

**Paramètres optionnels :**
- `email` : Email du client (pour intégration Crisp)
- `phone` : Téléphone du client (normalisation automatique)
- `force_queue` : Force l'ajout à la file même en heures d'ouverture

**Réponse attendue :**
```json
{
  "success": true,
  "message": "Test - Demande ajoutée à la file d'attente",
  "queue_id": "550e8400-e29b-41d4-a716-446655440000",
  "scheduled_for": "2025-07-29T09:00:00.000Z",
  "next_business_hours": "29/07/2025 09:00",
  "processed": "queued",
  "test_mode": true
}
```

### 2. Simuler un Résultat d'Appel

**Endpoint :** `POST /api/test/call-result/:queueId`

```bash
# Remplacer QUEUE_ID par l'ID récupéré à l'étape 1
curl -X POST "https://simplauto-agent-api-production2.up.railway.app/api/test/call-result/QUEUE_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "result": "En attente de rappel",
    "call_status": "answered",
    "reason": "Centre occupé, rappeler dans 2h"
  }'
```

**Paramètres :**
- `result` (requis) : Résultat de l'appel
- `call_status` : Statut technique de l'appel (défaut: "answered")
- `reason` : Motif détaillé (optionnel)

**Valeurs `result` possibles :**

| Valeur | Description | Action |
|--------|-------------|---------|
| `"Accepté"` | Remboursement accordé | ✅ Terminé (callback Make.com) |
| `"Refusé"` | Remboursement refusé | ❌ Terminé (callback Make.com) |
| `"En attente de rappel"` | Centre demande rappel | 🔄 Reprogrammé (+2h, +4h, +1j) |
| `"no_answer"` | Pas de réponse | 📞 Retry (+30min, +1h, +2h) |
| `"voicemail"` | Messagerie vocale | 📧 Retry (+30min, +1h, +2h) |
| `"failed"` | Erreur technique | ⚠️ Retry (+15min, +30min, +1h) |

### 3. Monitoring de la File d'Attente

#### Statut Général
```bash
curl "https://simplauto-agent-api-production2.up.railway.app/api/queue/status"
```

**Réponse :**
```json
{
  "success": true,
  "pending": 2,
  "processing": 0,
  "completed": 5,
  "failed": 1,
  "stats": {
    "total_requests": 8,
    "successful_calls": 5,
    "failed_calls": 1,
    "callbacks_requested": 3
  },
  "next_items": [
    {
      "id": "uuid-1",
      "reference": "TEST123",
      "scheduled_for": "2025-07-29T09:00:00Z",
      "type": "callback",
      "attempts": 2
    }
  ],
  "business_hours": false,
  "next_business_time": "29/07/2025 09:00"
}
```

#### Prochaine Heure d'Ouverture
```bash
curl "https://simplauto-agent-api-production2.up.railway.app/api/queue/next-business-hours"
```

#### Forcer le Traitement (Debug)
```bash
curl -X POST "https://simplauto-agent-api-production2.up.railway.app/api/queue/process"
```

### 4. Scénarios de Test Automatiques

**Endpoint :** `POST /api/test/scenarios`

#### Scénario 1 : Boucle de Rappels
```bash
curl -X POST "https://simplauto-agent-api-production2.up.railway.app/api/test/scenarios" \
  -H "Content-Type: application/json" \
  -d '{"scenario": "callback_loop"}'
```

**Ce qui se passe :**
1. Crée une demande
2. Simule 3 "En attente de rappel" successifs
3. Au 3ème, marque comme échec définitif

#### Scénario 2 : Échecs Techniques
```bash
curl -X POST "https://simplauto-agent-api-production2.up.railway.app/api/test/scenarios" \
  -H "Content-Type: application/json" \
  -d '{"scenario": "technical_failures"}'
```

**Ce qui se passe :**
1. Crée une demande
2. Simule 3 "no_answer" successifs  
3. Au 3ème, marque comme échec définitif

#### Scénario 3 : Résultats Mixtes
```bash
curl -X POST "https://simplauto-agent-api-production2.up.railway.app/api/test/scenarios" \
  -H "Content-Type: application/json" \
  -d '{"scenario": "mixed_results"}'
```

**Ce qui se passe :**
1. Crée 3 demandes
2. Résultats : "Accepté", "Refusé", "En attente de rappel"
3. Montre tous les cas possibles

## Workflows de Test Complets

### Test 1 : Workflow Basique

```bash
# 1. Ajouter une demande
RESPONSE=$(curl -s -X POST "https://simplauto-agent-api-production2.up.railway.app/api/test/webhook" \
  -H "Content-Type: application/json" \
  -d '{"force_queue": true}')

echo "Réponse: $RESPONSE"

# 2. Extraire le queue_id (manuel ou avec jq)
QUEUE_ID="uuid-récupéré-de-la-réponse"

# 3. Vérifier le statut
curl "https://simplauto-agent-api-production2.up.railway.app/api/queue/status"

# 4. Simuler un résultat
curl -X POST "https://simplauto-agent-api-production2.up.railway.app/api/test/call-result/$QUEUE_ID" \
  -H "Content-Type: application/json" \
  -d '{"result": "Accepté"}'

# 5. Vérifier que c'est terminé
curl "https://simplauto-agent-api-production2.up.railway.app/api/queue/status"
```

### Test 2 : Boucle de Rappels

```bash
# 1. Créer une demande
curl -X POST "https://simplauto-agent-api-production2.up.railway.app/api/test/webhook" \
  -d '{"force_queue": true}'

# Récupérer QUEUE_ID, puis :

# 2. Premier rappel
curl -X POST "https://simplauto-agent-api-production2.up.railway.app/api/test/call-result/$QUEUE_ID" \
  -d '{"result": "En attente de rappel"}'

# 3. Vérifier reprogrammation (+2h)
curl "https://simplauto-agent-api-production2.up.railway.app/api/queue/status"

# 4. Répéter avec le nouveau QUEUE_ID...
```

### Test 3 : Horaires d'Ouverture

```bash
# Vérifier l'heure actuelle
curl "https://simplauto-agent-api-production2.up.railway.app/api/queue/next-business-hours"

# Test en heures d'ouverture (Lun-Ven 9h-12h, 14h-17h)
curl -X POST "https://simplauto-agent-api-production2.up.railway.app/api/test/webhook" \
  -d '{}'  # Sans force_queue

# Test hors horaires
curl -X POST "https://simplauto-agent-api-production2.up.railway.app/api/test/webhook" \
  -d '{"force_queue": true}'
```

## Validation des Résultats

### Vérifications à Faire

1. **File d'attente :**
   - Les demandes sont bien ajoutées (`pending` augmente)
   - Les statuts changent correctement (`processing` → `completed`/`failed`)

2. **Rappels :**
   - Les callbacks sont reprogrammés avec les bons délais
   - Limite de 3 rappels respectée

3. **Horaires :**
   - Programmation uniquement en heures d'ouverture
   - Calcul correct du prochain créneau

4. **Intégrité :**
   - Pas de doublons d'ID
   - Historique conservé
   - Stats cohérentes

### Cas d'Erreur à Tester

```bash
# ID inexistant
curl -X POST ".../api/test/call-result/inexistant" -d '{"result": "Accepté"}'
# → 500 Error

# Résultat invalide  
curl -X POST ".../api/test/call-result/VALID_ID" -d '{"result": "InvalidStatus"}'
# → 400 Bad Request

# Scénario inexistant
curl -X POST ".../api/test/scenarios" -d '{"scenario": "inexistant"}'
# → 400 Bad Request avec liste des scénarios disponibles
```

## Nettoyage

```bash
# Nettoyer les anciens éléments (> 7 jours)
curl -X POST "https://simplauto-agent-api-production2.up.railway.app/api/queue/cleanup"
```

## Logs et Debug

Les logs détaillés sont disponibles dans Railway pour suivre :
- Ajouts à la file d'attente
- Traitements et reprogrammations  
- Erreurs et échecs
- Nettoyages automatiques

**Emojis dans les logs :**
- 📥 Webhook reçu
- ⏰ Hors horaires 
- 🎯 Traitement d'élément
- ✅ Succès
- 🔄 Reprogrammation
- ❌ Échec
- 🧹 Nettoyage