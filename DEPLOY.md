# Déploiement sur Railway

## Étapes de déploiement

### 1. Connecter GitHub à Railway

1. Aller sur [railway.app](https://railway.app)
2. Se connecter avec GitHub
3. Cliquer sur "New Project"
4. Sélectionner "Deploy from GitHub repo"
5. Choisir `simplauto/simplauto-agent-api`

### 2. Configuration des variables d'environnement

Dans Railway, aller dans l'onglet "Variables" et ajouter :

```env
AI_AGENT_ID=agent_3601k1d905x7e78t8dx6dvzdyk5v
AI_AGENT_API_URL=https://api.elevenlabs.io/v1/convai/twilio/outbound-call
ELEVENLABS_API_KEY=sk_e1538037fba860d9bd3564e440e47207485444ef1a3803ce
AGENT_PHONE_NUMBER=+33977555287
AGENT_PHONE_NUMBER_ID=phnum_9301k0xvfvj2eevbd60csa7s3xhv
PORT=3001
```

### 3. Déploiement automatique

Railway détectera automatiquement :
- `package.json` pour Node.js
- `railway.toml` pour la configuration
- La commande `npm start`
- Le health check sur `/api/health`

### 4. URL de production

Une fois déployé, Railway fournira une URL comme :
`https://simplauto-agent-api-production.up.railway.app`

### 5. Webhook URL pour Simplauto

Configurer dans Simplauto :
```
https://your-app.up.railway.app/api/webhook/refund-request
```

### 6. Test du déploiement

```bash
curl https://your-app.up.railway.app/api/health
```

Devrait retourner :
```json
{
  "success": true,
  "message": "API Simplauto Refund opérationnelle",
  "agent": {
    "phoneNumber": "+33977555287",
    "phoneNumberId": "phnum_9301k0xvfvj2eevbd60csa7s3xhv",
    "agentId": "agent_3601k1d905x7e78t8dx6dvzdyk5v"
  }
}
```

## Redéploiement

Chaque push sur `main` déclenchera automatiquement un redéploiement.