/**
 * Tests d'intégration simplifiés pour les fonctions principales
 */

const { isBusinessHours, getNextBusinessTime, getRetryDelay } = require('../src/businessHours');
const fs = require('fs').promises;
const path = require('path');

describe('Business Hours Integration', () => {
  test('should correctly calculate next business time across different scenarios', () => {
    // Vendredi soir → Lundi matin
    const fridayEvening = new Date('2025-08-01T19:00:00'); // Vendredi 19h
    const nextTime = getNextBusinessTime(fridayEvening);
    
    expect(nextTime.getDay()).toBe(1); // Lundi
    expect(nextTime.getHours()).toBe(9);
  });

  test('should handle retry delays correctly for different scenarios', () => {
    // Test des délais de callback
    expect(getRetryDelay('callback_requested', 1)).toBe(120); // 2h
    expect(getRetryDelay('callback_requested', 2)).toBe(240); // 4h
    expect(getRetryDelay('callback_requested', 3)).toBe(1440); // 1 jour
    
    // Test des délais d'échec technique
    expect(getRetryDelay('no_answer', 1)).toBe(30); // 30min
    expect(getRetryDelay('no_answer', 2)).toBe(60); // 1h
    expect(getRetryDelay('no_answer', 3)).toBe(120); // 2h
  });
});

describe('Queue System Integration', () => {
  const { addToQueue, getQueueStats } = require('../src/queueManager');

  const testData = {
    booking: { date: "2025-07-28T15:30:00Z" },
    order: { reference: "INTEGRATION_TEST" },
    customer: { first_name: "Integration", last_name: "Test" },
    vehicule: { brand: "Test", model: "Car", registration_number: "IT-123-TST" },
    center: { phone: "0123456789" }
  };

  test('should handle complete workflow without errors', async () => {
    // Ajouter un item à la queue
    const queueResult = await addToQueue(testData);
    
    expect(queueResult.id).toBeDefined();
    expect(queueResult.scheduled_for).toBeDefined();

    // Vérifier les stats
    const stats = await getQueueStats();
    expect(stats.pending).toBeGreaterThan(0);
    expect(stats.stats.total_requests).toBeGreaterThan(0);
  });

  test('should maintain consistent data structure', async () => {
    const stats = await getQueueStats();
    
    // Vérifier la structure des stats
    expect(stats).toHaveProperty('pending');
    expect(stats).toHaveProperty('processing');
    expect(stats).toHaveProperty('completed');
    expect(stats).toHaveProperty('failed');
    expect(stats).toHaveProperty('stats');
    expect(stats).toHaveProperty('next_items');

    // Vérifier les types
    expect(typeof stats.pending).toBe('number');
    expect(typeof stats.processing).toBe('number');
    expect(typeof stats.completed).toBe('number');
    expect(typeof stats.failed).toBe('number');
    expect(Array.isArray(stats.next_items)).toBe(true);
  });
});