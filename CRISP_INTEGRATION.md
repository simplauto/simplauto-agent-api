# Intégration Crisp - Explications Clients Automatiques

## Vue d'ensemble

L'API récupère automatiquement les conversations Crisp des clients pour extraire leurs explications de demande de remboursement et les transmettre à l'agent ElevenLabs pour des appels personnalisés.

## Configuration Requise

### Variables d'environnement Crisp

```env
CRISP_IDENTIFIER=your_identifier_here
CRISP_KEY=your_secret_key_here  
CRISP_WEBSITE_ID=ceea62fb-2516-4517-ad8b-a67259cb2781
```

### Variable d'environnement Claude

```env
CLAUDE_API_KEY=sk-ant-your_claude_api_key_here
```

## Fonctionnement

### 1. Déclenchement Automatique

Lorsqu'un webhook contient un `customer.email`, le système :

```json
{
  "customer": {
    "first_name": "Alexandre",
    "last_name": "Senra Magalhaes", 
    "email": "alexandremagalhaes@sapo.pt"  // ← Déclenche l'intégration Crisp
  }
}
```

### 2. Recherche des Conversations

L'API Crisp recherche toutes les conversations associées à cet email :

```bash
GET https://api.crisp.chat/v1/website/{WEBSITE_ID}/conversations/1?search_query={email}&search_type=text
```

**Headers requis :**
- `Authorization: Basic {base64(identifier:key)}`
- `X-Crisp-Tier: plugin`

### 3. Récupération des Messages

Pour chaque conversation trouvée, récupération des messages :

```bash
GET https://api.crisp.chat/v1/website/{WEBSITE_ID}/conversation/{session_id}/messages
```

### 4. Analyse avec Claude AI

Claude analyse les messages avec ce prompt optimisé :

```
INSTRUCTION IMPORTANTE : Cherche uniquement dans cette conversation l'explication que donne le client pour justifier sa demande de remboursement. Ignore tout le reste de la conversation (salutations, demandes d'informations, etc.).

Si le client explique pourquoi il demande un remboursement, résume UNIQUEMENT cette explication en 1 phrase courte et claire.
Si aucune explication de motif de remboursement n'est donnée, réponds "Aucune explication fournie".

Exemples de bonnes réponses:
- "Sa voiture est tombée en panne sur la route"
- "Il a eu un problème de santé" 
- "Il n'a pas pu se libérer du travail"
- "Le centre était fermé à son arrivée"
```

### 5. Transmission à ElevenLabs

L'explication extraite est transmise comme variable dynamique :

```json
{
  "dynamic_variables": {
    "nom_client": "Alexandre Senra Magalhaes",
    "reference": "B8F9UNQY",
    "explication_client": "Il a eu un problème de santé"
  }
}
```

## Utilisation dans ElevenLabs

### Dans le prompt de l'agent :

```
Bonjour, je vous appelle concernant {{nom_client}} qui avait un rendez-vous le {{date_reservation}}.

{{#if explication_client}}
Le client nous a expliqué que : {{explication_client}}
{{/if}}

Pouvez-vous valider cette demande de remboursement ?
```

## Logs de Debug

### Recherche de conversations
```
📧 Email client détecté, recherche Crisp... alexandremagalhaes@sapo.pt
🔍 Recherche conversations Crisp pour: alexandremagalhaes@sapo.pt
✅ Trouvé 1 conversation(s) pour alexandremagalhaes@sapo.pt
📋 Détails des conversations: [...]
```

### Récupération des messages
```
✅ Trouvé 15 message(s) pour session session_771b910a-8c91-4e9a-a827-cf90dcb12bb8
💬 Premiers messages: [...]
```

### Analyse Claude
```
📝 Texte des messages à analyser par Claude: Client: J'ai eu un problème de santé...
🤖 Envoi à Claude API pour analyse...
✅ Résumé Claude: Il a eu un problème de santé
```

## Gestion des Erreurs

### Email manquant
```json
{
  "customer": {
    "email": null  // ← Pas d'intégration Crisp
  }
}
```
→ `explication_client: null`

### Aucune conversation trouvée
```
❌ Aucune conversation trouvée pour cet email
```
→ `explication_client: null`

### Erreur Claude API
```
❌ Erreur résumé Claude: Request failed with status code 404
```
→ `explication_client: null`

## Modèles Claude Supportés

- `claude-3-haiku-20240307` (actuellement utilisé)
- `claude-3-sonnet-20240229` 
- `claude-3-opus-20240229`

## Limites

- **Email requis** : Sans email client, pas d'intégration Crisp
- **Conversations publiques uniquement** : Seules les conversations Crisp publiques sont accessibles
- **Claude Rate Limits** : Respecte les limites de l'API Anthropic
- **Timeout** : 30 secondes maximum par requête

## Sécurité

- **Authentification Crisp** : Basic Auth avec identifier/key
- **Clé Claude** : Bearer token sécurisé
- **Pas de stockage** : Aucune donnée conversation stockée localement
- **Logs limités** : Seuls les premiers messages sont loggés pour debug