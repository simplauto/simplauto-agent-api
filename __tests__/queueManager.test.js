/**
 * Tests pour le gestionnaire de file d'attente
 */

const fs = require('fs').promises;
const path = require('path');
const { addToQueue, getReadyItems, markAsProcessing, updateCallResult, getQueueStats, cleanupOldItems } = require('../src/queueManager');

// Tests simplifiés sans mock complexe

describe('queueManager', () => {
  // Nettoyer le fichier de queue après chaque test
  afterEach(async () => {
    try {
      await fs.unlink(path.join(__dirname, '..', 'queue.json'));
    } catch (e) { /* ignore */ }
    try {
      await fs.unlink(path.join(__dirname, '..', 'queue.lock'));
    } catch (e) { /* ignore */ }
  });

  const sampleWebhookData = {
    booking: {
      date: "2025-07-28T15:30:00Z",
      backoffice_url: "https://www.simplauto.com/backoffice/test"
    },
    order: {
      reference: "TEST123"
    },
    customer: {
      first_name: "John",
      last_name: "Doe",
      email: "john@test.com",
      phone: "0123456789"
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

  describe('addToQueue', () => {
    test('should add item to queue successfully', async () => {
      const result = await addToQueue(sampleWebhookData);
      
      expect(result).toHaveProperty('id');
      expect(result).toHaveProperty('scheduled_for');
      expect(result.id).toMatch(/^[0-9a-f-]{36}$/); // UUID format
    });

    test('should schedule for specific time when provided', async () => {
      const scheduledTime = new Date('2025-07-29T09:00:00Z');
      const result = await addToQueue(sampleWebhookData, scheduledTime);
      
      expect(new Date(result.scheduled_for)).toEqual(scheduledTime);
    });

    test('should increment stats when adding items', async () => {
      await addToQueue(sampleWebhookData);
      await addToQueue(sampleWebhookData);
      
      const stats = await getQueueStats();
      expect(stats.stats.total_requests).toBe(2);
      expect(stats.pending).toBe(2);
    });
  });

  describe('getReadyItems', () => {
    test('should return empty array when no items are ready', async () => {
      // Ajouter un item programmé pour demain
      const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
      await addToQueue(sampleWebhookData, tomorrow);
      
      const readyItems = await getReadyItems();
      expect(readyItems).toEqual([]);
    });

    test('should return items scheduled for now or past', async () => {
      // Ajouter un item programmé pour il y a 1 heure
      const pastTime = new Date(Date.now() - 60 * 60 * 1000);
      await addToQueue(sampleWebhookData, pastTime);
      
      const readyItems = await getReadyItems();
      expect(readyItems).toHaveLength(1);
      expect(readyItems[0].data.order.reference).toBe('TEST123');
    });
  });

  describe('markAsProcessing', () => {
    test('should move item from pending to processing', async () => {
      const queueResult = await addToQueue(sampleWebhookData);
      const itemId = queueResult.id;
      
      const item = await markAsProcessing(itemId);
      
      expect(item.status).toBe('processing');
      expect(item).toHaveProperty('processing_started_at');
      
      const stats = await getQueueStats();
      expect(stats.pending).toBe(0);
      expect(stats.processing).toBe(1);
    });

    test('should throw error if item not found', async () => {
      await expect(markAsProcessing('non-existent-id')).rejects.toThrow();
    });
  });

  describe('updateCallResult', () => {
    let itemId;

    beforeEach(async () => {
      const queueResult = await addToQueue(sampleWebhookData);
      itemId = queueResult.id;
      await markAsProcessing(itemId);
    });

    test('should complete item on Accepté result', async () => {
      const callResult = {
        conversationId: 'conv_123',
        call_status: 'answered',
        result: 'Accepté',
        reason: null
      };

      const updateResult = await updateCallResult(itemId, callResult);
      
      expect(updateResult.status).toBe('completed');
      
      const stats = await getQueueStats();
      expect(stats.processing).toBe(0);
      expect(stats.completed).toBe(1);
      expect(stats.stats.successful_calls).toBe(1);
    });

    test('should complete item on Refusé result', async () => {
      const callResult = {
        conversationId: 'conv_123',
        call_status: 'answered',
        result: 'Refusé',
        reason: 'Client absent'
      };

      const updateResult = await updateCallResult(itemId, callResult);
      
      expect(updateResult.status).toBe('completed');
      expect(updateResult.item.history).toHaveLength(1);
      expect(updateResult.item.history[0].reason).toBe('Client absent');
    });

    test('should reschedule on first callback request', async () => {
      const callResult = {
        conversationId: 'conv_123',
        call_status: 'answered',
        result: 'En attente de rappel',
        reason: null
      };

      const updateResult = await updateCallResult(itemId, callResult);
      
      expect(updateResult.status).toBe('rescheduled');
      expect(updateResult).toHaveProperty('next_attempt');
      expect(updateResult.item.attempts.callback_requests).toBe(1);
      
      const stats = await getQueueStats();
      expect(stats.pending).toBe(1);
      expect(stats.processing).toBe(0);
    });

    test('should fail after 3 callback requests', async () => {
      // Simuler 3 tentatives de callback
      for (let i = 1; i <= 3; i++) {
        if (i > 1) {
          await markAsProcessing(itemId);
        }
        
        const callResult = {
          conversationId: `conv_${i}`, 
          call_status: 'answered',
          result: 'En attente de rappel'
        };

        const updateResult = await updateCallResult(itemId, callResult);
        
        if (i < 3) {
          expect(updateResult.status).toBe('rescheduled');
          // Récupérer le nouvel ID après reprogrammation
          const stats = await getQueueStats();
          itemId = stats.next_items[0].id;
        } else {
          expect(updateResult.status).toBe('failed');
          expect(updateResult.item.failure_reason).toContain('Trop de rappels');
        }
      }
    });

    test('should reschedule on technical failure', async () => {
      const callResult = {
        conversationId: null,
        call_status: 'no_answer',
        result: 'no_answer'
      };

      const updateResult = await updateCallResult(itemId, callResult);
      
      expect(updateResult.status).toBe('rescheduled');
      expect(updateResult.item.attempts.technical_failures).toBe(1);
    });

    test('should fail after 3 technical failures', async () => {
      // Simuler 3 échecs techniques
      for (let i = 1; i <= 3; i++) {
        if (i > 1) {
          await markAsProcessing(itemId);
        }
        
        const callResult = {
          conversationId: null,
          call_status: 'no_answer', 
          result: 'no_answer'
        };

        const updateResult = await updateCallResult(itemId, callResult);
        
        if (i < 3) {
          expect(updateResult.status).toBe('rescheduled');
          // Récupérer le nouvel ID après reprogrammation
          const stats = await getQueueStats();
          itemId = stats.next_items[0].id;
        } else {
          expect(updateResult.status).toBe('failed');
          expect(updateResult.item.failure_reason).toContain('Trop d\'échecs techniques');
        }
      }
    });
  });

  describe('getQueueStats', () => {
    test('should return correct stats for empty queue', async () => {
      const stats = await getQueueStats();
      
      expect(stats).toEqual({
        pending: 0,
        processing: 0,
        completed: 0,
        failed: 0,
        stats: {
          total_requests: 0,
          successful_calls: 0,
          failed_calls: 0,
          callbacks_requested: 0
        },
        next_items: []
      });
    });

    test('should return correct stats after various operations', async () => {
      // Ajouter plusieurs items et les traiter différemment
      const item1 = await addToQueue(sampleWebhookData);
      const item2 = await addToQueue(sampleWebhookData);
      
      // Compléter le premier
      await markAsProcessing(item1.id);
      await updateCallResult(item1.id, {
        conversationId: 'conv_1',
        call_status: 'answered',
        result: 'Accepté'
      });
      
      const stats = await getQueueStats();
      expect(stats.pending).toBe(1);
      expect(stats.completed).toBe(1);
      expect(stats.stats.total_requests).toBe(2);
      expect(stats.stats.successful_calls).toBe(1);
    });
  });

  describe('cleanupOldItems', () => {
    test('should not remove recent items', async () => {
      const queueResult = await addToQueue(sampleWebhookData);
      await markAsProcessing(queueResult.id);
      await updateCallResult(queueResult.id, {
        conversationId: 'conv_1',
        call_status: 'answered',
        result: 'Accepté'
      });
      
      const cleanupResult = await cleanupOldItems();
      expect(cleanupResult.cleanedCompleted).toBe(0);
      
      const stats = await getQueueStats();
      expect(stats.completed).toBe(1);
    });
  });
});