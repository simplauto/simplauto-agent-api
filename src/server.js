require('dotenv').config();
const express = require('express');
const { normalizeFrenchPhoneNumber } = require('./phoneUtils');
const AIAgentClient = require('./aiAgentClient');
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

// Stockage en mémoire des conversations en cours
const activeConversations = new Map();

// Configuration webhook Make.com
const MAKE_WEBHOOK_URL = 'https://hook.eu1.make.com/nsdyueym7xwbj1waaia3jrbjolanjelu';

// Configuration ElevenLabs webhook
const ELEVENLABS_WEBHOOK_SECRET = process.env.ELEVENLABS_WEBHOOK_SECRET || 'wsec_83ee0abb9a7c7f991ef33083a8db240e887acb1dcac08cf36b82fe62c4083c9b';

// Fonction pour vérifier la signature HMAC d'ElevenLabs
function verifyElevenLabsSignature(body, signature) {
  try {
    const expectedSignature = crypto
      .createHmac('sha256', ELEVENLABS_WEBHOOK_SECRET)
      .update(body, 'utf8')
      .digest('hex');
    
    const receivedSignature = signature.replace('sha256=', '');
    return crypto.timingSafeEqual(
      Buffer.from(expectedSignature, 'hex'),
      Buffer.from(receivedSignature, 'hex')
    );
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
    const { booking, order, customer, vehicule, center } = req.body;
    
    // Normaliser le numéro de téléphone français
    const rawPhoneNumber = center.phone || center.affiliated_phone;
    const normalizedPhone = normalizeFrenchPhoneNumber(rawPhoneNumber);

    const refundRequest = {
      reference: order.reference,
      nom_client: `${customer.first_name} ${customer.last_name}`,
      date_reservation: booking.date,
      marque_vehicule: vehicule.brand,
      modele_vehicule: vehicule.model,
      immatriculation: vehicule.registration_number,
      telephone_centre: normalizedPhone,
      backoffice_url: booking.backoffice_url
    };

    console.log('Demande de remboursement reçue:', {
      reference: refundRequest.reference,
      client: refundRequest.nom_client,
      telephone: `${normalizedPhone} (original: ${rawPhoneNumber})`
    });

    // Vérifier la configuration avant l'appel
    if (missingVars.length > 0) {
      return res.status(500).json({
        success: false,
        error: 'Configuration incomplète',
        missingVars
      });
    }

    // Appeler l'agent IA immédiatement
    const result = await aiClient.callAgentWithRetry(refundRequest);

    if (result.success) {
      // Stocker les informations de la conversation pour le callback
      activeConversations.set(result.conversationId, {
        reference: order.reference,
        backoffice_url: booking.backoffice_url || null, // Peut être null pour rétrocompatibilité
        customer_name: refundRequest.nom_client,
        phone_number: refundRequest.telephone_centre,
        timestamp: Date.now()
      });

      console.log('Conversation stockée:', {
        conversationId: result.conversationId,
        reference: order.reference,
        backoffice_url: booking.backoffice_url
      });

      res.json({
        success: true,
        message: 'Appel téléphonique initié avec succès',
        conversationId: result.conversationId,
        sipCallId: result.sipCallId
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Erreur lors de l\'appel téléphonique',
        details: result.error
      });
    }

  } catch (error) {
    console.error('Erreur:', error.message);
    res.status(500).json({
      success: false,
      error: 'Erreur interne du serveur'
    });
  }
});

// Endpoint pour Client Tool validation_remboursement
app.post('/api/tools/validation-remboursement', express.json(), async (req, res) => {
  try {
    console.log('=== CLIENT TOOL validation_remboursement APPELÉ ===');
    console.log('Body reçu:', req.body);
    console.log('===============================================');

    // Extraire les paramètres du tool
    const { status, motif, commentaire } = req.body;

    // Validation des paramètres requis
    if (!status) {
      console.error('Paramètre status manquant dans le Client Tool');
      return res.status(400).json({
        success: false,
        error: 'Le paramètre status est requis'
      });
    }

    // Valider que le status est dans les valeurs attendues
    const validStatuses = ['Accepté', 'Refusé', 'En attente de rappel'];
    if (!validStatuses.includes(status)) {
      console.error('Status invalide:', status);
      return res.status(400).json({
        success: false,
        error: `Status doit être un de: ${validStatuses.join(', ')}`
      });
    }

    // Construire la réponse de validation
    const validationResult = {
      status,
      ...(motif && { motif }),
      ...(commentaire && { commentaire }),
      timestamp: new Date().toISOString(),
      source: 'agent_validation'
    };

    console.log('Validation enregistrée:', validationResult);

    // Retourner une réponse structurée pour l'agent
    const response = {
      success: true,
      message: `Validation enregistrée: ${status}`,
      data: validationResult
    };

    console.log('Réponse envoyée à ElevenLabs:', response);
    
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
      status: 'string (required) - Accepté, Refusé, ou En attente de rappel',
      motif: 'string (optional) - Motif du refus si applicable',
      commentaire: 'string (optional) - Commentaire additionnel'
    },
    example_request: {
      status: 'Accepté',
      commentaire: 'Remboursement validé par le centre'
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
    const body = req.body.toString();

    // Vérifier la signature HMAC
    if (!signature) {
      console.error('Pas de signature ElevenLabs-Signature dans les headers');
      return res.status(401).json({ error: 'Missing signature' });
    }
    
    if (!verifyElevenLabsSignature(body, signature)) {
      console.error('Signature HMAC invalide pour le webhook ElevenLabs');
      console.error('Signature reçue:', signature);
      console.error('Body pour HMAC:', body.substring(0, 200));
      return res.status(401).json({ error: 'Invalid signature' });
    }
    
    console.log('✅ Signature HMAC validée');

    const webhookData = JSON.parse(body);
    const conversationId = webhookData.conversation_id;

    console.log('Webhook post-call reçu:', {
      conversationId,
      status: webhookData.status
    });

    // Récupérer les données de conversation depuis le cache ou les dynamic variables
    let conversationData = activeConversations.get(conversationId);
    
    if (!conversationData) {
      console.log('Conversation non trouvée dans le cache, récupération depuis ElevenLabs:', conversationId);
      
      // Récupérer depuis les dynamic variables d'ElevenLabs
      const dynamicVars = webhookData.conversation_initiation_client_data?.dynamic_variables;
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
    const transcript = webhookData.transcript || [];
    const { status, reason } = analyzeTranscriptWithLLM(transcript);

    // Déterminer le call_status
    let call_status = 'answered';
    const callDuration = webhookData.metadata?.call_duration_secs || 0;
    
    if (callDuration < 5 && transcript.length === 0) {
      call_status = 'no_answer';
    } else if (transcript.some(msg => msg.message && msg.message.toLowerCase().includes('voicemail'))) {
      call_status = 'voicemail';
    } else if (webhookData.status === 'failed') {
      call_status = 'failed';
    }

    // Créer la réponse de remboursement
    const refund_response = call_status === 'answered' ? {
      status,
      ...(reason && { reason }),
      comment: `Conversation analysée automatiquement`
    } : null;

    console.log('Analyse de la conversation:', {
      conversationId,
      call_status,
      refund_response
    });

    // Envoyer le callback vers Make.com si backoffice_url existe
    if (conversationData.backoffice_url) {
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
    }

    // Supprimer la conversation du cache
    activeConversations.delete(conversationId);

    res.status(200).json({ received: true });

  } catch (error) {
    console.error('Erreur dans le webhook post-call:', error.message);
    res.status(500).json({ error: 'Internal server error' });
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

  res.json({
    active_conversations: conversations,
    total_count: conversations.length,
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