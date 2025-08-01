require('dotenv').config();
const express = require('express');
const { normalizeFrenchPhoneNumber } = require('./phoneUtils');
const AIAgentClient = require('./aiAgentClient');
const { isBusinessHours, getNextBusinessTime, formatBusinessTime } = require('./businessHours');
const { addToQueue, getReadyItems, markAsProcessing, updateCallResult, getQueueStats, cleanupOldItems } = require('./queueManager');
const cron = require('node-cron');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());

// Configuration
const aiAgentConfig = {
  agentId: process.env.AI_AGENT_ID,
  apiUrl: process.env.AI_AGENT_API_URL,
  elevenlabsApiKey: process.env.ELEVENLABS_API_KEY,
  phoneNumber: process.env.AGENT_PHONE_NUMBER,
  phoneNumberId: process.env.AGENT_PHONE_NUMBER_ID
};

// Validation de la configuration au démarrage
const missingVars = [];
if (!aiAgentConfig.agentId) missingVars.push('AI_AGENT_ID');
if (!aiAgentConfig.apiUrl) missingVars.push('AI_AGENT_API_URL');
if (!aiAgentConfig.elevenlabsApiKey) missingVars.push('ELEVENLABS_API_KEY');
if (!aiAgentConfig.phoneNumber) missingVars.push('AGENT_PHONE_NUMBER');
if (!aiAgentConfig.phoneNumberId) missingVars.push('AGENT_PHONE_NUMBER_ID');

if (missingVars.length > 0) {
  console.error('❌ Variables d\'environnement manquantes:', missingVars.join(', '));
  console.error('Veuillez configurer ces variables dans Railway');
}

const aiClient = new AIAgentClient(aiAgentConfig);

// Variable pour éviter les traitements concurrents
let isProcessingQueue = false;

/**
 * Traite la file d'attente (appelé par le cron job)
 */
async function processQueue() {
  if (isProcessingQueue) {
    console.log('⏳ Traitement déjà en cours, skip...');
    return;
  }

  if (!isBusinessHours()) {
    console.log('⏰ Hors horaires d\'ouverture, skip traitement file');
    return;
  }

  isProcessingQueue = true;
  
  try {
    const readyItems = await getReadyItems();
    
    if (readyItems.length === 0) {
      console.log('📭 Aucun élément prêt dans la file d\'attente');
      return;
    }

    console.log(`📋 ${readyItems.length} élément(s) prêt(s) à traiter`);

    // Traiter seulement le premier élément (évite la surcharge)
    const item = readyItems[0];
    
    try {
      console.log(`🎯 Traitement de l'élément:`, {
        id: item.id,
        reference: item.data.order?.reference,
        type: item.type,
        attempts: item.attempts.total
      });

      // Marquer comme en cours de traitement
      await markAsProcessing(item.id);

      // Traiter la demande
      const result = await processRefundRequest(item.data);

      console.log(`✅ Traitement réussi:`, {
        id: item.id,
        conversationId: result.conversationId
      });

      // Le résultat sera mis à jour via le post-call webhook
      // On stocke juste l'ID de queue pour le retrouver
      activeConversations.set(result.conversationId, {
        ...activeConversations.get(result.conversationId),
        queue_item_id: item.id
      });

    } catch (error) {
      console.error(`❌ Erreur traitement élément ${item.id}:`, error.message);
      
      // Marquer comme échec technique pour retry
      await updateCallResult(item.id, {
        conversationId: null,
        call_status: 'failed',
        result: 'failed',
        reason: error.message
      });
    }

  } catch (error) {
    console.error('❌ Erreur processus file d\'attente:', error.message);
  } finally {
    isProcessingQueue = false;
  }
}

// Cron job : toutes les 5 minutes pendant les heures d'ouverture
cron.schedule('*/5 * * * *', async () => {
  await processQueue();
});

// Nettoyage quotidien à 2h du matin
cron.schedule('0 2 * * *', async () => {
  try {
    console.log('🧹 Nettoyage quotidien de la file d\'attente...');
    await cleanupOldItems();
  } catch (error) {
    console.error('❌ Erreur nettoyage:', error.message);
  }
});

console.log('⏰ Cron jobs configurés : traitement file (*/5 min) + nettoyage (2h)');

// Configuration Crisp
const CRISP_CONFIG = {
  identifier: process.env.CRISP_IDENTIFIER,
  key: process.env.CRISP_KEY,
  websiteId: process.env.CRISP_WEBSITE_ID
};

// Configuration Claude
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;

// Stockage en mémoire des conversations en cours
const activeConversations = new Map();

// Stockage des résultats du webhook tool validation_remboursement
const toolResults = new Map();

// Configuration webhook Make.com
const MAKE_WEBHOOK_URL = 'https://hook.eu1.make.com/nsdyueym7xwbj1waaia3jrbjolanjelu';

// Configuration ElevenLabs webhook
const ELEVENLABS_WEBHOOK_SECRET = process.env.ELEVENLABS_WEBHOOK_SECRET || 'wsec_83ee0abb9a7c7f991ef33083a8db240e887acb1dcac08cf36b82fe62c4083c9b';

// Fonction pour chercher les conversations Crisp par email
async function searchCrispConversations(email) {
  try {
    if (!CRISP_CONFIG.identifier || !CRISP_CONFIG.key || !CRISP_CONFIG.websiteId) {
      console.warn('⚠️ Configuration Crisp manquante');
      return null;
    }

    const auth = Buffer.from(`${CRISP_CONFIG.identifier}:${CRISP_CONFIG.key}`).toString('base64');
    
    console.log('🔍 Recherche conversations Crisp pour:', email);
    
    // Chercher les conversations avec l'email
    const response = await axios.get(`https://api.crisp.chat/v1/website/${CRISP_CONFIG.websiteId}/conversations/1`, {
      headers: {
        'Authorization': `Basic ${auth}`,
        'X-Crisp-Tier': 'plugin'
      },
      params: {
        search_query: email,
        search_type: 'text'
      }
    });

    const conversations = response.data?.data || [];
    console.log(`✅ Trouvé ${conversations.length} conversation(s) pour ${email}`);
    
    // Log détaillé des conversations trouvées
    if (conversations.length > 0) {
      console.log('📋 Détails des conversations:', JSON.stringify(conversations, null, 2));
    }
    
    return conversations;
  } catch (error) {
    console.error('❌ Erreur recherche Crisp:', error.message);
    return null;
  }
}

// Fonction pour récupérer les messages d'une conversation Crisp
async function getCrispMessages(sessionId) {
  try {
    const auth = Buffer.from(`${CRISP_CONFIG.identifier}:${CRISP_CONFIG.key}`).toString('base64');
    
    const response = await axios.get(`https://api.crisp.chat/v1/website/${CRISP_CONFIG.websiteId}/conversation/${sessionId}/messages`, {
      headers: {
        'Authorization': `Basic ${auth}`,
        'X-Crisp-Tier': 'plugin'
      }
    });

    const messages = response.data?.data || [];
    console.log(`✅ Trouvé ${messages.length} message(s) pour session ${sessionId}`);
    
    // Log détaillé des messages
    if (messages.length > 0) {
      console.log('💬 Premiers messages:', JSON.stringify(messages.slice(0, 3), null, 2));
    }
    
    return messages;
  } catch (error) {
    console.error('❌ Erreur récupération messages Crisp:', error.message);
    return [];
  }
}

// Fonction pour résumer le motif de remboursement avec Claude
async function summarizeRefundMotive(messages) {
  try {
    if (!CLAUDE_API_KEY) {
      console.warn('⚠️ Clé Claude API manquante');
      return null;
    }

    // Construire le contexte des messages
    const messageText = messages
      .filter(msg => msg.content && msg.type === 'text')
      .map(msg => `${msg.from === 'user' ? 'Client' : 'Support'}: ${msg.content}`)
      .join('\n');

    if (!messageText.trim()) {
      console.log('⚠️ Pas de messages texte trouvés');
      return null;
    }

    const prompt = `Voici une conversation de support client Simplauto (plateforme de réservation de contrôles techniques).

Conversation:
${messageText}

INSTRUCTION IMPORTANTE : Cherche uniquement dans cette conversation l'explication que donne le client pour justifier sa demande de remboursement. Ignore tout le reste de la conversation (salutations, demandes d'informations, etc.).

Si le client explique pourquoi il demande un remboursement, résume UNIQUEMENT cette explication en 1 phrase courte et claire.
Si aucune explication de motif de remboursement n'est donnée, réponds "Aucune explication fournie".

Exemples de bonnes réponses:
- "Sa voiture est tombée en panne sur la route"
- "Il a eu un problème de santé" 
- "Il n'a pas pu se libérer du travail"
- "Le centre était fermé à son arrivée"

NE PAS inclure: les détails administratifs, les salutations, les demandes d'informations du support.`;

    console.log('📝 Texte des messages à analyser par Claude:', messageText);
    console.log('🤖 Envoi à Claude API pour analyse...');
    
    const response = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-3-haiku-20240307',
      max_tokens: 150,
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ]
    }, {
      headers: {
        'x-api-key': CLAUDE_API_KEY,
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01'
      }
    });

    const summary = response.data?.content?.[0]?.text?.trim();
    console.log('✅ Résumé Claude:', summary);
    
    return summary || null;
  } catch (error) {
    console.error('❌ Erreur résumé Claude:', error.message);
    console.error('Status:', error.response?.status);
    console.error('Response data:', error.response?.data);
    console.error('Headers sent:', {
      'x-api-key': CLAUDE_API_KEY ? 'présente' : 'manquante',
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01'
    });
    return null;
  }
}

// Fonction pour vérifier la signature HMAC d'ElevenLabs
function verifyElevenLabsSignature(body, signature) {
  try {
    // Support des deux formats : "sha256=hash" et "t=timestamp,v0=hash"
    let receivedSignature;
    let timestamp;
    
    if (signature.includes('t=') && signature.includes('v0=')) {
      // Format ElevenLabs: t=timestamp,v0=hash
      const parts = signature.split(',');
      timestamp = parts.find(p => p.startsWith('t=')).replace('t=', '');
      receivedSignature = parts.find(p => p.startsWith('v0=')).replace('v0=', '');
      
      // Créer le payload à signer : timestamp.body
      const payloadToSign = `${timestamp}.${body}`;
      const expectedSignature = crypto
        .createHmac('sha256', ELEVENLABS_WEBHOOK_SECRET)
        .update(payloadToSign, 'utf8')
        .digest('hex');
        
      return crypto.timingSafeEqual(
        Buffer.from(expectedSignature, 'hex'),
        Buffer.from(receivedSignature, 'hex')
      );
    } else {
      // Format classique: sha256=hash
      const expectedSignature = crypto
        .createHmac('sha256', ELEVENLABS_WEBHOOK_SECRET)
        .update(body, 'utf8')
        .digest('hex');
      
      receivedSignature = signature.replace('sha256=', '');
      return crypto.timingSafeEqual(
        Buffer.from(expectedSignature, 'hex'),
        Buffer.from(receivedSignature, 'hex')
      );
    }
  } catch (error) {
    console.error('Erreur lors de la vérification HMAC:', error.message);
    return false;
  }
}

// Fonction pour analyser le transcript avec un LLM simple
function analyzeTranscriptWithLLM(transcript) {
  const fullTranscript = transcript.map(msg => {
    const role = msg.role === 'user' ? 'Centre' : 'Agent';
    return `${role}: ${msg.message || ''}`;
  }).join('\n').toLowerCase();

  console.log('Transcript à analyser:', fullTranscript);
  console.log('Transcript détaillé:', transcript.map(msg => `${msg.role}: "${msg.message}"`));

  // Analyse structurée du transcript
  let status = 'En attente de rappel';
  let reason = null;

  // Détecter les acceptations (être plus strict)
  if (fullTranscript.includes('oui') && (fullTranscript.includes('valide le remboursement') || fullTranscript.includes('accord') || fullTranscript.includes('je valide'))) {
    status = 'Accepté';
  }
  // Détecter les refus avec patterns améliorés
  else if (
    fullTranscript.includes('non') ||
    fullTranscript.includes('refuse') ||
    fullTranscript.includes('refus') ||
    fullTranscript.includes('pas possible') ||
    fullTranscript.includes('impossible') ||
    fullTranscript.includes('ne valide pas') ||
    fullTranscript.includes('on ne valide pas')
  ) {
    status = 'Refusé';
    
    // Extraire le motif du refus
    if (fullTranscript.includes('pas présenté') || fullTranscript.includes('absent')) {
      reason = 'Client absent au rendez-vous';
    } else if (fullTranscript.includes('perdu le créneau') || fullTranscript.includes('pas prévenu')) {
      reason = 'Client absent - créneau perdu sans préavis';
    } else if (fullTranscript.includes('délai') || fullTranscript.includes('trop tard')) {
      reason = 'Demande hors délai';
    } else if (fullTranscript.includes('politique') || fullTranscript.includes('règlement')) {
      reason = 'Politique de remboursement du centre';
    } else {
      reason = 'Motif non spécifié par le centre';
    }
  }

  return { status, reason };
}

/**
 * Traite une demande de remboursement (extraction données Crisp + appel ElevenLabs)
 */
async function processRefundRequest(webhookData) {
  const { booking, order, customer, vehicule, center } = webhookData;
  
  try {
    // Normaliser le numéro de téléphone français
    const rawPhoneNumber = center.phone || center.affiliated_phone;
    const normalizedPhone = normalizeFrenchPhoneNumber(rawPhoneNumber);

    // Extraire et normaliser le numéro de téléphone client
    let customerPhone = null;
    if (customer.phone) {
      customerPhone = normalizeFrenchPhoneNumber(customer.phone);
      console.log('📞 Numéro client:', customerPhone, '(original:', customer.phone + ')');
    }

    // Récupérer l'explication du client depuis Crisp
    let customerExplanation = null;
    if (customer.email) {
      console.log('📧 Email client détecté, recherche Crisp...', customer.email);
      
      const conversations = await searchCrispConversations(customer.email);
      if (conversations && conversations.length > 0) {
        // Prendre la conversation la plus récente
        const latestConversation = conversations[0];
        const messages = await getCrispMessages(latestConversation.session_id);
        
        if (messages.length > 0) {
          customerExplanation = await summarizeRefundMotive(messages);
        }
      }
    }

    const refundRequest = {
      reference: order.reference,
      nom_client: `${customer.first_name} ${customer.last_name}`,
      date_reservation: booking.date,
      marque_vehicule: vehicule.brand,
      modele_vehicule: vehicule.model,
      immatriculation: vehicule.registration_number,
      telephone_centre: normalizedPhone,
      telephone_client: customerPhone,
      backoffice_url: booking.backoffice_url,
      explication_client: customerExplanation
    };

    console.log('Traitement demande de remboursement:', {
      reference: refundRequest.reference,
      client: refundRequest.nom_client,
      telephone: `${normalizedPhone} (original: ${rawPhoneNumber})`
    });

    // Vérifier la configuration avant l'appel
    if (missingVars.length > 0) {
      throw new Error(`Configuration incomplète: ${missingVars.join(', ')}`);
    }

    // Appeler l'agent IA
    const result = await aiClient.callAgentWithRetry(refundRequest);

    if (result.success) {
      // Stocker les informations de la conversation pour le callback
      activeConversations.set(result.conversationId, {
        reference: order.reference,
        backoffice_url: booking.backoffice_url || null,
        customer_name: refundRequest.nom_client,
        phone_number: refundRequest.telephone_centre,
        timestamp: Date.now()
      });

      console.log('Appel téléphonique initié avec succès:', {
        conversationId: result.conversationId,
        reference: order.reference,
        backoffice_url: booking.backoffice_url
      });

      return {
        success: true,
        conversationId: result.conversationId,
        sipCallId: result.sipCallId
      };
    } else {
      throw new Error(`Erreur lors de l'appel téléphonique: ${result.error}`);
    }

  } catch (error) {
    console.error('Erreur lors du traitement de la demande:', error.message);
    throw error;
  }
}

// Validation des données du webhook
const validateRefundRequest = (req, res, next) => {
  const { booking, order, customer, vehicule, center } = req.body;

  if (!booking || !order || !customer || !vehicule || !center) {
    return res.status(400).json({
      success: false,
      error: 'Structure JSON invalide',
      expected: 'booking, order, customer, vehicule, center'
    });
  }

  const missingFields = [];
  if (!order.reference) missingFields.push('order.reference');
  if (!customer.first_name) missingFields.push('customer.first_name');
  if (!customer.last_name) missingFields.push('customer.last_name');
  if (!booking.date) missingFields.push('booking.date');
  if (!center.phone && !center.affiliated_phone) missingFields.push('center.phone ou center.affiliated_phone');
  
  // customer.email est optionnel pour Crisp
  // booking.backoffice_url est optionnel pour la rétrocompatibilité

  if (missingFields.length > 0) {
    return res.status(400).json({
      success: false,
      error: 'Données manquantes',
      missingFields
    });
  }

  // Normaliser les champs vides
  if (!vehicule.brand || vehicule.brand === '') vehicule.brand = 'non renseignée';
  if (!vehicule.model || vehicule.model === '') vehicule.model = 'non renseigné';
  if (!vehicule.registration_number || vehicule.registration_number === '') vehicule.registration_number = 'non renseignée';

  next();
};

// Endpoint webhook principal
app.post('/api/webhook/refund-request', validateRefundRequest, async (req, res) => {
  try {
    const webhookData = { ...req.body };
    const { order } = webhookData;
    
    console.log('📥 Webhook reçu:', {
      reference: order.reference,
      customer: `${webhookData.customer.first_name} ${webhookData.customer.last_name}`,
      business_hours: isBusinessHours()
    });

    // Vérifier la configuration avant de traiter
    if (missingVars.length > 0) {
      return res.status(500).json({
        success: false,
        error: 'Configuration incomplète',
        missingVars
      });
    }

    // Vérifier si on est dans les horaires d'ouverture
    if (isBusinessHours()) {
      console.log('✅ Horaires d\'ouverture - Traitement immédiat');
      
      try {
        const result = await processRefundRequest(webhookData);
        
        res.json({
          success: true,
          message: 'Appel téléphonique initié avec succès',
          conversationId: result.conversationId,
          sipCallId: result.sipCallId,
          processed: 'immediately'
        });
      } catch (error) {
        console.error('Erreur traitement immédiat:', error.message);
        res.status(500).json({
          success: false,
          error: 'Erreur lors du traitement de la demande',
          details: error.message
        });
      }
    } else {
      console.log('⏰ Hors horaires d\'ouverture - Ajout à la file d\'attente');
      
      try {
        const queueResult = await addToQueue(webhookData);
        const nextBusinessTime = getNextBusinessTime();
        
        res.json({
          success: true,
          message: 'Demande ajoutée à la file d\'attente',
          queue_id: queueResult.id,
          scheduled_for: queueResult.scheduled_for,
          next_business_hours: formatBusinessTime(nextBusinessTime),
          processed: 'queued'
        });
      } catch (error) {
        console.error('Erreur ajout file d\'attente:', error.message);
        res.status(500).json({
          success: false,
          error: 'Erreur lors de l\'ajout à la file d\'attente',
          details: error.message
        });
      }
    }

  } catch (error) {
    console.error('Erreur webhook:', error.message);
    res.status(500).json({
      success: false,
      error: 'Erreur interne du serveur'
    });
  }
});

// Endpoint pour webhook tool validation_remboursement
app.post('/api/tools/validation-remboursement', express.json(), async (req, res) => {
  try {
    console.log('=== WEBHOOK TOOL validation_remboursement APPELÉ ===');
    console.log('Headers:', req.headers);
    console.log('Body reçu:', req.body);
    console.log('===============================================');

    // Extraire les paramètres du tool avec les noms français exacts
    const { statut, motif } = req.body;

    // Validation des paramètres requis
    if (!statut) {
      console.error('Paramètre statut manquant dans le Client Tool');
      return res.status(400).json({
        success: false,
        error: 'Le paramètre statut est requis'
      });
    }

    // Valider que le statut est dans les valeurs attendues
    const validStatuses = ['Accepté', 'Refusé', 'En attente de rappel'];
    if (!validStatuses.includes(statut)) {
      console.error('Statut invalide:', statut);
      return res.status(400).json({
        success: false,
        error: `Statut doit être un de: ${validStatuses.join(', ')}`
      });
    }

    // Construire la réponse de validation
    const validationResult = {
      statut,
      ...(motif && { motif }),
      timestamp: new Date().toISOString(),
      source: 'agent_validation'
    };

    console.log('Validation enregistrée:', validationResult);

    // Retourner une réponse structurée pour l'agent
    const response = {
      success: true,
      message: `Validation enregistrée: ${statut}`,
      data: validationResult
    };

    console.log('Réponse envoyée à ElevenLabs:', response);
    
    // Essayer de récupérer le conversationId depuis les headers ElevenLabs
    const conversationId = req.headers['x-conversation-id'] || req.headers['conversation-id'] || req.headers['xi-conversation-id'];
    
    if (conversationId) {
      // Stocker le résultat du tool pour l'utiliser dans le post-call webhook
      toolResults.set(conversationId, {
        statut,
        motif,
        timestamp: new Date().toISOString(),
        source: 'webhook_tool'
      });
      console.log('✅ Résultat du tool stocké pour conversation:', conversationId);
    } else {
      console.warn('⚠️ Impossible de récupérer le conversationId depuis les headers');
      console.log('Headers disponibles:', Object.keys(req.headers));
    }
    
    res.json(response);

  } catch (error) {
    console.error('Erreur dans le Client Tool validation_remboursement:', error.message);
    res.status(500).json({
      success: false,
      error: 'Erreur interne du serveur'
    });
  }
});

// Endpoint de test pour le Client Tool validation_remboursement
app.get('/api/tools/validation-remboursement', (req, res) => {
  res.json({
    success: true,
    message: 'Client Tool validation_remboursement est opérationnel',
    endpoint: '/api/tools/validation-remboursement',
    method: 'POST',
    expected_parameters: {
      statut: 'string (required) - Accepté, Refusé, ou En attente de rappel',
      motif: 'string (optional) - Motif du refus si applicable'
    },
    example_request: {
      statut: 'Refusé',
      motif: 'Le client est arrivé en retard et a raté son créneau.'
    }
  });
});

// Note: L'ancien système de monitoring a été remplacé par le webhook post-call d'ElevenLabs

// Endpoint de debug pour vérifier le statut d'une conversation
app.get('/api/webhook/conversation/:conversationId/status', async (req, res) => {
  try {
    const { conversationId } = req.params;
    
    // Récupérer directement via l'API ElevenLabs
    const response = await axios.get(`https://api.elevenlabs.io/v1/convai/conversations/${conversationId}`, {
      headers: {
        'xi-api-key': aiAgentConfig.elevenlabsApiKey
      }
    });

    const conversation = response.data;
    const transcript = conversation.transcript || [];
    const { status, reason } = analyzeTranscriptWithLLM(transcript);
    
    res.json({
      success: true,
      conversationId,
      status: conversation.status,
      analyzed_result: { status, reason },
      transcript_preview: transcript.slice(0, 3).map(msg => `${msg.role}: ${msg.message || ''}`),
      call_duration: conversation.metadata?.call_duration_secs
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Endpoint de test pour vérifier que le webhook arrive
app.post('/api/webhook/post-call-test', express.json(), async (req, res) => {
  console.log('=== WEBHOOK TEST REÇU ===');
  console.log('Headers:', req.headers);
  console.log('Body:', req.body);
  console.log('========================');
  
  res.status(200).json({ received: true, timestamp: new Date().toISOString() });
});

// Endpoint post-call webhook d'ElevenLabs
app.post('/api/webhook/post-call', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    console.log('=== POST-CALL WEBHOOK REÇU ===');
    console.log('Headers:', req.headers);
    console.log('Body length:', req.body.length);
    console.log('==============================');
    
    const signature = req.headers['elevenlabs-signature'];
    const body = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : JSON.stringify(req.body);

    // TEMPORAIRE : Validation HMAC désactivée pour debug
    console.log('🔍 DEBUG - Signature reçue:', signature);
    console.log('🔍 DEBUG - Webhook secret configuré:', !!process.env.ELEVENLABS_WEBHOOK_SECRET);
    console.log('🔍 DEBUG - Body preview:', body.substring(0, 200));
    
    // Vérifier la signature HMAC (temporairement en mode log uniquement)
    if (!signature) {
      console.warn('⚠️ Pas de signature ElevenLabs-Signature dans les headers');
    } else {
      const isValid = verifyElevenLabsSignature(body, signature);
      console.log('🔍 HMAC validation result:', isValid);
      if (!isValid) {
        console.warn('⚠️ Signature HMAC invalide, mais on continue pour debug');
      } else {
        console.log('✅ Signature HMAC validée');
      }
    }

    const webhookData = JSON.parse(body);
    console.log('🔍 DEBUG - Webhook data complet:', JSON.stringify(webhookData, null, 2));
    
    // Les données ElevenLabs sont dans le champ 'data'
    const eventData = webhookData.data || webhookData;
    const conversationId = eventData.conversation_id || eventData.conversationId || eventData.id;
    const webhookStatus = eventData.status || eventData.call_status || eventData.state;

    console.log('Webhook post-call reçu:', {
      conversationId,
      status: webhookStatus,
      availableKeys: Object.keys(webhookData)
    });

    // Récupérer les données de conversation depuis le cache ou les dynamic variables
    let conversationData = activeConversations.get(conversationId);
    
    if (!conversationData) {
      console.log('Conversation non trouvée dans le cache, récupération depuis ElevenLabs:', conversationId);
      
      // Récupérer depuis les dynamic variables d'ElevenLabs
      const dynamicVars = eventData.conversation_initiation_client_data?.dynamic_variables;
      if (dynamicVars && dynamicVars.reference) {
        conversationData = {
          reference: dynamicVars.reference,
          backoffice_url: dynamicVars.backoffice_url || null,
          customer_name: dynamicVars.nom_client,
          phone_number: dynamicVars.system__called_number,
          timestamp: Date.now()
        };
        console.log('Données récupérées depuis dynamic variables:', conversationData);
      } else {
        console.log('Impossible de récupérer les données de conversation');
        return res.status(200).json({ received: true, skipped: 'conversation data not found' });
      }
    }

    // Analyser le transcript pour obtenir le statut et motif
    const transcript = eventData.transcript || [];
    
    // Chercher les données du webhook tool dans les tool_results du transcript
    let toolData = null;
    for (const turn of transcript) {
      if (turn.tool_results) {
        for (const toolResult of turn.tool_results) {
          if (toolResult.tool_name === 'validation_remboursement' && toolResult.result_value) {
            try {
              const resultValue = JSON.parse(toolResult.result_value);
              if (resultValue.data) {
                toolData = resultValue.data;
                console.log('✅ Données du webhook tool trouvées dans tool_results:', toolData);
                break;
              }
            } catch (e) {
              console.warn('Erreur parsing tool result_value:', e.message);
            }
          }
        }
      }
      if (toolData) break;
    }
    
    // Utiliser les données du tool si disponibles, sinon analyser le transcript
    let status, reason;
    if (toolData && toolData.statut) {
      status = toolData.statut;
      reason = toolData.motif || null;
      console.log('✅ Utilisation des données exactes du webhook tool:', { status, reason });
    } else {
      const analyzed = analyzeTranscriptWithLLM(transcript);
      status = analyzed.status;
      reason = analyzed.reason;
      console.log('⚠️ Fallback vers analyse automatique (pas de données tool):', { status, reason });
    }

    // Déterminer le call_status
    let call_status = 'answered';
    const callDuration = eventData.metadata?.call_duration_secs || 0;
    
    if (callDuration < 5 && transcript.length === 0) {
      call_status = 'no_answer';
    } else if (transcript.some(msg => msg.message && msg.message.toLowerCase().includes('voicemail'))) {
      call_status = 'voicemail';
    } else if (webhookStatus === 'failed') {
      call_status = 'failed';
    }

    // Créer la réponse de remboursement
    const refund_response = call_status === 'answered' ? {
      status,
      ...(reason && { reason })
    } : null;

    console.log('Analyse de la conversation:', {
      conversationId,
      call_status,
      refund_response
    });

    // Vérifier si c'est un élément de la file d'attente
    const queueItemId = conversationData.queue_item_id;
    let queueUpdate = null;
    
    if (queueItemId) {
      console.log('📋 Mise à jour file d\'attente pour:', queueItemId);
      
      try {
        // Déterminer le résultat pour la file d'attente
        let queueResult = status;
        if (call_status !== 'answered') {
          queueResult = call_status; // no_answer, voicemail, failed
        }
        
        queueUpdate = await updateCallResult(queueItemId, {
          conversationId,
          call_status,
          result: queueResult,
          reason
        });
        
        console.log('✅ File d\'attente mise à jour:', {
          status: queueUpdate.status,
          next_attempt: queueUpdate.next_attempt
        });
        
      } catch (error) {
        console.error('❌ Erreur mise à jour file d\'attente:', error.message);
      }
    }

    // Envoyer le callback vers Make.com seulement si terminé définitivement
    const shouldSendCallback = conversationData.backoffice_url && 
      (!queueUpdate || queueUpdate.status === 'completed' || queueUpdate.status === 'failed');
    
    if (shouldSendCallback) {
      const payload = {
        booking: {
          backoffice_url: conversationData.backoffice_url
        },
        order: {
          reference: conversationData.reference
        },
        call_result: {
          call_status,
          ...(refund_response && { refund_response })
        }
      };

      console.log('Envoi callback vers Make.com:', JSON.stringify(payload, null, 2));

      try {
        const response = await axios.post(MAKE_WEBHOOK_URL, payload, {
          headers: { 'Content-Type': 'application/json' },
          timeout: 30000
        });

        console.log('Callback envoyé avec succès:', {
          reference: conversationData.reference,
          status: response.status
        });
      } catch (callbackError) {
        console.error('Erreur lors de l\'envoi du callback:', callbackError.message);
      }
    } else if (queueUpdate && queueUpdate.status === 'rescheduled') {
      console.log('🔄 Callback différé - appel reprogrammé:', {
        reference: conversationData.reference,
        next_attempt: queueUpdate.next_attempt
      });
    }

    // Supprimer la conversation du cache
    activeConversations.delete(conversationId);

    const responseData = { 
      received: true,
      ...(queueUpdate && {
        queue_status: queueUpdate.status,
        ...(queueUpdate.next_attempt && { next_attempt: queueUpdate.next_attempt })
      })
    };

    res.status(200).json(responseData);

  } catch (error) {
    console.error('Erreur dans le webhook post-call:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Endpoints de monitoring file d'attente

// Statut général de la file d'attente
app.get('/api/queue/status', async (req, res) => {
  try {
    const stats = await getQueueStats();
    res.json({
      success: true,
      ...stats,
      business_hours: isBusinessHours(),
      next_business_time: formatBusinessTime(getNextBusinessTime())
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Prochaine heure d'ouverture
app.get('/api/queue/next-business-hours', (req, res) => {
  const nextTime = getNextBusinessTime();
  
  res.json({
    success: true,
    current_time: formatBusinessTime(new Date()),
    is_business_hours: isBusinessHours(),
    next_business_time: formatBusinessTime(nextTime),
    next_business_timestamp: nextTime.toISOString()
  });
});

// Forcer le traitement de la file (debug)
app.post('/api/queue/process', async (req, res) => {
  try {
    if (isProcessingQueue) {
      return res.json({
        success: false,
        message: 'Traitement déjà en cours'
      });
    }
    
    console.log('🔧 Traitement forcé de la file d\'attente');
    await processQueue();
    
    res.json({
      success: true,
      message: 'Traitement de la file d\'attente lancé'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Nettoyer manuellement les anciens éléments
app.post('/api/queue/cleanup', async (req, res) => {
  try {
    const result = await cleanupOldItems();
    res.json({
      success: true,
      message: 'Nettoyage terminé',
      ...result
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Endpoints de test pour simuler des scénarios

// Test webhook avec données fictives (sans appel réel)
app.post('/api/test/webhook', async (req, res) => {
  try {
    const testData = {
      booking: {
        date: "2025-07-28T15:30:00Z",
        backoffice_url: "https://www.simplauto.com/backoffice/test-" + Date.now()
      },
      order: {
        reference: "TEST" + Math.random().toString(36).substr(2, 6).toUpperCase()
      },
      customer: {
        first_name: "Test",
        last_name: "User",
        email: req.body.email || "test@simplauto.com",
        phone: req.body.phone || "0123456789"
      },
      vehicule: {
        brand: "Peugeot",
        model: "308",
        registration_number: "AB-123-CD"
      },
      center: {
        phone: "0987654321"
      }
    };

    // Simuler le comportement du webhook principal mais sans appel réel
    console.log('🧪 Test webhook reçu:', {
      reference: testData.order.reference,
      business_hours: isBusinessHours(),
      force_queue: req.body.force_queue
    });

    // Forcer l'ajout à la file si demandé, sinon suivre la logique normale
    const shouldQueue = req.body.force_queue || !isBusinessHours();

    if (shouldQueue) {
      console.log('⏰ Test - Ajout à la file d\'attente');
      
      const queueResult = await addToQueue(testData);
      const nextBusinessTime = getNextBusinessTime();
      
      res.json({
        success: true,
        message: 'Test - Demande ajoutée à la file d\'attente',
        queue_id: queueResult.id,
        scheduled_for: queueResult.scheduled_for,
        next_business_hours: formatBusinessTime(nextBusinessTime),
        processed: 'queued',
        test_mode: true
      });
    } else {
      // Simuler un appel réussi
      const fakeConversationId = 'test_conv_' + Date.now();
      
      res.json({
        success: true,
        message: 'Test - Appel téléphonique simulé avec succès',
        conversationId: fakeConversationId,
        processed: 'immediately',
        test_mode: true
      });
    }

  } catch (error) {
    console.error('Erreur test webhook:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
      test_mode: true
    });
  }
});

// Simuler un résultat d'appel pour un item de la file
app.post('/api/test/call-result/:queueId', async (req, res) => {
  try {
    const { queueId } = req.params;
    const { result, call_status = 'answered', reason } = req.body;

    if (!result) {
      return res.status(400).json({
        success: false,
        error: 'Le champ result est requis',
        valid_results: ['Accepté', 'Refusé', 'En attente de rappel', 'no_answer', 'voicemail', 'failed']
      });
    }

    console.log('🧪 Test résultat d\'appel:', {
      queueId,
      result,
      call_status
    });

    const callResult = {
      conversationId: 'test_conv_' + Date.now(),
      call_status,
      result,
      reason
    };

    const updateResult = await updateCallResult(queueId, callResult);

    res.json({
      success: true,
      message: 'Test - Résultat d\'appel simulé',
      queue_status: updateResult.status,
      ...(updateResult.next_attempt && { next_attempt: updateResult.next_attempt }),
      item_history: updateResult.item.history,
      test_mode: true
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      test_mode: true
    });
  }
});

// Simuler différents scénarios de test
app.post('/api/test/scenarios', async (req, res) => {
  try {
    const { scenario } = req.body;
    
    const scenarios = {
      'callback_loop': async () => {
        // Créer un item et simuler 3 callbacks
        const queueResult = await addToQueue({
          booking: { date: "2025-07-28T15:30:00Z" },
          order: { reference: "CALLBACK_TEST" },
          customer: { first_name: "Callback", last_name: "Test", email: "callback@test.com" },
          vehicule: { brand: "Test", model: "Car", registration_number: "CB-123-TEST" },
          center: { phone: "0123456789" }
        });

        let itemId = queueResult.id;
        const results = [];

        for (let i = 1; i <= 3; i++) {
          await markAsProcessing(itemId);
          const result = await updateCallResult(itemId, {
            conversationId: `callback_${i}`,
            call_status: 'answered',
            result: 'En attente de rappel'
          });
          
          results.push({
            attempt: i,
            status: result.status,
            next_attempt: result.next_attempt
          });

          if (result.status === 'rescheduled') {
            // Récupérer le nouvel ID
            const stats = await getQueueStats();
            itemId = stats.next_items[0]?.id;
          }
        }

        return { scenario: 'callback_loop', results };
      },

      'technical_failures': async () => {
        // Créer un item et simuler 3 échecs techniques
        const queueResult = await addToQueue({
          booking: { date: "2025-07-28T15:30:00Z" },
          order: { reference: "TECH_FAIL_TEST" },
          customer: { first_name: "TechFail", last_name: "Test", email: "techfail@test.com" },
          vehicule: { brand: "Test", model: "Car", registration_number: "TF-123-TEST" },
          center: { phone: "0123456789" }
        });

        let itemId = queueResult.id;
        const results = [];

        for (let i = 1; i <= 3; i++) {
          await markAsProcessing(itemId);
          const result = await updateCallResult(itemId, {
            conversationId: null,
            call_status: 'no_answer',
            result: 'no_answer'
          });
          
          results.push({
            attempt: i,
            status: result.status,
            next_attempt: result.next_attempt
          });

          if (result.status === 'rescheduled') {
            const stats = await getQueueStats();
            itemId = stats.next_items[0]?.id;
          }
        }

        return { scenario: 'technical_failures', results };
      },

      'mixed_results': async () => {
        // Créer plusieurs items avec différents résultats
        const items = [];
        
        for (const [index, result] of [['Accepté'], ['Refusé'], ['En attente de rappel']].entries()) {
          const queueResult = await addToQueue({
            booking: { date: "2025-07-28T15:30:00Z" },
            order: { reference: `MIXED_${index + 1}` },
            customer: { first_name: "Mixed", last_name: `Test${index + 1}` },
            vehicule: { brand: "Test", model: "Car", registration_number: `MX-${index + 1}-TST` },
            center: { phone: "0123456789" }
          });

          await markAsProcessing(queueResult.id);
          const updateResult = await updateCallResult(queueResult.id, {
            conversationId: `mixed_${index + 1}`,
            call_status: 'answered',
            result: result[0]
          });

          items.push({
            reference: `MIXED_${index + 1}`,
            result: result[0],
            status: updateResult.status
          });
        }

        return { scenario: 'mixed_results', items };
      }
    };

    if (!scenarios[scenario]) {
      return res.status(400).json({
        success: false,
        error: 'Scénario non reconnu',
        available_scenarios: Object.keys(scenarios)
      });
    }

    const result = await scenarios[scenario]();

    res.json({
      success: true,
      message: `Test scénario ${scenario} exécuté`,
      ...result,
      test_mode: true
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      test_mode: true
    });
  }
});

// Debug endpoint pour vérifier les conversations actives
app.get('/api/debug/conversations', (req, res) => {
  const conversations = Array.from(activeConversations.entries()).map(([id, data]) => ({
    conversationId: id,
    reference: data.reference,
    backoffice_url: data.backoffice_url,
    age_minutes: Math.round((Date.now() - data.timestamp) / 60000)
  }));

  const toolResultsArray = Array.from(toolResults.entries()).map(([id, data]) => ({
    conversationId: id,
    statut: data.statut,
    motif: data.motif,
    timestamp: data.timestamp
  }));

  res.json({
    active_conversations: conversations,
    total_count: conversations.length,
    tool_results: toolResultsArray,
    tool_results_count: toolResultsArray.length,
    webhook_secret_configured: !!process.env.ELEVENLABS_WEBHOOK_SECRET
  });
});

// Health check
app.get('/api/health', (req, res) => {
  const configStatus = {
    hasAgentId: !!aiAgentConfig.agentId,
    hasApiUrl: !!aiAgentConfig.apiUrl,
    hasApiKey: !!aiAgentConfig.elevenlabsApiKey,
    hasPhoneNumber: !!aiAgentConfig.phoneNumber,
    hasPhoneNumberId: !!aiAgentConfig.phoneNumberId
  };

  const isConfigured = Object.values(configStatus).every(Boolean);

  res.json({
    success: true,
    message: 'API Simplauto Refund opérationnelle',
    configured: isConfigured,
    config: configStatus,
    agent: isConfigured ? aiClient.getPhoneInfo() : null
  });
});

// 404
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint non trouvé'
  });
});

// Démarrage
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 API démarrée sur le port ${PORT}`);
  console.log(`📞 Agent: ${aiAgentConfig.agentId}`);
  console.log(`📱 Numéro: ${aiAgentConfig.phoneNumber}`);
});