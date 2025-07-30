require('dotenv').config();
const express = require('express');
const { normalizeFrenchPhoneNumber } = require('./phoneUtils');
const AIAgentClient = require('./aiAgentClient');
const axios = require('axios');

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
      telephone_centre: normalizedPhone
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

// Fonction pour analyser le résultat d'une conversation
async function analyzeConversationResult(conversationId) {
  try {
    const response = await axios.get(`https://api.elevenlabs.io/v1/convai/conversations/${conversationId}`, {
      headers: {
        'xi-api-key': aiAgentConfig.elevenlabsApiKey
      }
    });

    const conversation = response.data;
    
    // Analyser le statut de l'appel
    let call_status = 'failed';
    let refund_response = null;

    if (conversation.status === 'done') {
      const transcript = conversation.transcript || [];
      const hasTranscript = transcript.length > 0;
      const callDuration = conversation.metadata?.duration_seconds || 0;

      // Déterminer le statut de l'appel
      if (callDuration < 5 && !hasTranscript) {
        call_status = 'no_answer';
      } else if (transcript.some(msg => msg.message && msg.message.toLowerCase().includes('voicemail'))) {
        call_status = 'voicemail';
      } else if (hasTranscript) {
        call_status = 'answered';
        
        // Analyser la réponse du centre seulement si l'appel a été décroché
        const fullTranscript = transcript.map(msg => msg.message || '').join(' ').toLowerCase();
        
        if (fullTranscript.includes('accepte') || fullTranscript.includes('valide') || fullTranscript.includes('accord')) {
          refund_response = { status: 'Accepté', comment: 'Remboursement accepté par le centre' };
        } else if (fullTranscript.includes('refuse') || fullTranscript.includes('impossible') || fullTranscript.includes('pas possible')) {
          // Extraire le motif du refus
          let reason = 'Motif non spécifié';
          if (fullTranscript.includes('absent')) reason = 'Client absent au rendez-vous';
          else if (fullTranscript.includes('délai')) reason = 'Hors délai pour le remboursement';
          else if (fullTranscript.includes('politique')) reason = 'Politique de remboursement du centre';
          
          refund_response = { 
            status: 'Refusé', 
            reason: reason,
            comment: 'Remboursement refusé par le centre'
          };
        } else {
          refund_response = { status: 'En attente de rappel', comment: 'Réponse du centre à clarifier' };
        }
      }
    }

    return { call_status, refund_response, conversation };
  } catch (error) {
    console.error('Erreur lors de l\'analyse de la conversation:', error.message);
    return { call_status: 'failed', refund_response: null, error: error.message };
  }
}

// Fonction pour envoyer le callback vers Make.com
async function sendCallbackToMake(conversationData, callResult) {
  try {
    // Ne pas envoyer le callback si pas de backoffice_url
    if (!conversationData.backoffice_url) {
      console.log('Pas de backoffice_url - callback ignoré pour:', conversationData.reference);
      return { success: true, skipped: true };
    }

    const payload = {
      booking: {
        backoffice_url: conversationData.backoffice_url
      },
      order: {
        reference: conversationData.reference
      },
      call_result: {
        call_status: callResult.call_status,
        ...(callResult.refund_response && { refund_response: callResult.refund_response })
      }
    };

    console.log('Envoi callback vers Make.com:', JSON.stringify(payload, null, 2));

    const response = await axios.post(MAKE_WEBHOOK_URL, payload, {
      headers: {
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });

    console.log('Callback envoyé avec succès vers Make.com:', {
      reference: conversationData.reference,
      status: response.status
    });

    return { success: true };
  } catch (error) {
    console.error('Erreur lors de l\'envoi du callback:', error.message);
    return { success: false, error: error.message };
  }
}

// Fonction de surveillance des conversations
async function monitorConversations() {
  const conversationsToCheck = Array.from(activeConversations.entries());
  
  for (const [conversationId, conversationData] of conversationsToCheck) {
    try {
      // Vérifier les conversations de plus de 30 secondes
      const age = Date.now() - conversationData.timestamp;
      if (age < 30000) continue;

      const result = await analyzeConversationResult(conversationId);
      
      if (result.call_status !== 'failed') {
        // Envoyer le callback vers Make.com
        await sendCallbackToMake(conversationData, result);
        
        // Retirer la conversation de la surveillance
        activeConversations.delete(conversationId);
        
        console.log('Conversation terminée et callback envoyé:', {
          conversationId,
          reference: conversationData.reference,
          call_status: result.call_status
        });
      } else if (age > 300000) { // 5 minutes timeout
        // Timeout - envoyer un callback d'échec
        await sendCallbackToMake(conversationData, { call_status: 'failed', refund_response: null });
        activeConversations.delete(conversationId);
        
        console.log('Conversation en timeout:', conversationId);
      }
    } catch (error) {
      console.error('Erreur lors du monitoring de la conversation:', conversationId, error.message);
    }
  }
}

// Démarrer le monitoring toutes les 30 secondes
setInterval(monitorConversations, 30000);

// Endpoint de debug pour vérifier le statut d'une conversation
app.get('/api/webhook/conversation/:conversationId/status', async (req, res) => {
  try {
    const { conversationId } = req.params;
    const result = await analyzeConversationResult(conversationId);
    
    res.json({
      success: true,
      conversationId,
      ...result
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
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