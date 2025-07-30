const axios = require('axios');

class AIAgentClient {
  constructor(config) {
    this.agentId = config.agentId;
    this.apiUrl = config.apiUrl;
    this.apiKey = config.elevenlabsApiKey || config.apiKey;
    this.phoneNumber = config.phoneNumber;
    this.phoneNumberId = config.phoneNumberId;
    this.maxRetries = config.maxRetries || 3;
    this.retryDelay = config.retryDelay || 30000; // 30 secondes
  }


  async callAgent(refundRequest) {
    if (!refundRequest.telephone_centre) {
      console.error('Numéro de téléphone du centre manquant:', refundRequest.reference);
      return {
        success: false,
        error: 'Numéro de téléphone du centre de contrôle technique requis'
      };
    }

    const payload = {
      agent_id: this.agentId,
      agent_phone_number_id: this.phoneNumberId,
      to_number: refundRequest.telephone_centre,
      conversation_initiation_client_data: {
        dynamic_variables: {
          nom_client: refundRequest.nom_client,
          date_reservation: refundRequest.date_reservation,
          marque_vehicule: refundRequest.marque_vehicule,
          modele_vehicule: refundRequest.modele_vehicule,
          immatriculation: refundRequest.immatriculation,
          reference: refundRequest.reference
        }
      }
    };

    console.log('Appel téléphonique vers le centre de contrôle technique:', {
      agent: this.agentId,
      from: this.phoneNumber,
      to: refundRequest.telephone_centre,
      reference: refundRequest.reference,
      client: refundRequest.nom_client
    });

    try {
      const response = await axios.post(this.apiUrl, payload, {
        headers: {
          'xi-api-key': this.apiKey,
          'Content-Type': 'application/json'
        },
        timeout: 60000 // 60 secondes
      });

      console.log('Appel téléphonique initié avec succès:', {
        reference: refundRequest.reference,
        conversationId: response.data.conversation_id,
        sipCallId: response.data.sip_call_id,
        status: response.status
      });

      return {
        success: true,
        data: response.data,
        response: `Appel téléphonique initié vers ${refundRequest.telephone_centre}`,
        conversationId: response.data.conversation_id,
        sipCallId: response.data.sip_call_id
      };

    } catch (error) {
      console.error('Erreur lors de l\'appel téléphonique:', {
        reference: refundRequest.reference,
        from: this.phoneNumber,
        to: refundRequest.telephone_centre,
        error: error.message,
        status: error.response?.status,
        data: error.response?.data
      });

      return {
        success: false,
        error: error.message,
        details: error.response?.data
      };
    }
  }

  async callAgentWithRetry(refundRequest, currentRetry = 0) {
    const result = await this.callAgent(refundRequest);
    
    if (result.success) {
      return result;
    }

    if (currentRetry < this.maxRetries) {
      console.log('Nouvelle tentative d\'appel à l\'agent IA:', {
        reference: refundRequest.reference,
        attempt: currentRetry + 1,
        maxRetries: this.maxRetries
      });

      await new Promise(resolve => setTimeout(resolve, this.retryDelay));
      return this.callAgentWithRetry(refundRequest, currentRetry + 1);
    }

    console.error('Échec définitif de l\'appel à l\'agent IA:', {
      reference: refundRequest.reference,
      attempts: this.maxRetries + 1
    });

    return result;
  }

  validateConfiguration() {
    const errors = [];
    
    if (!this.agentId) errors.push('AI_AGENT_ID manquant');
    if (!this.apiUrl) errors.push('AI_AGENT_API_URL manquant');
    if (!this.apiKey) errors.push('ELEVENLABS_API_KEY manquant');
    if (!this.phoneNumberId) errors.push('AGENT_PHONE_NUMBER_ID manquant');
    if (!this.phoneNumber) errors.push('AGENT_PHONE_NUMBER manquant');

    if (errors.length > 0) {
      throw new Error(`Configuration de l'agent IA invalide: ${errors.join(', ')}`);
    }
  }

  getPhoneInfo() {
    return {
      phoneNumber: this.phoneNumber,
      phoneNumberId: this.phoneNumberId,
      agentId: this.agentId
    };
  }
}

module.exports = AIAgentClient;