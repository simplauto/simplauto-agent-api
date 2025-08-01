/**
 * Gestionnaire de file d'attente JSON avec verrouillage
 */

const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { getNextBusinessTime, getRetryDelay } = require('./businessHours');

const QUEUE_FILE = path.join(__dirname, '..', 'queue.json');
const LOCK_FILE = path.join(__dirname, '..', 'queue.lock');
const LOCK_TIMEOUT = 10000; // 10 secondes maximum d'attente

/**
 * Structure par défaut de la file d'attente
 */
const DEFAULT_QUEUE = {
  pending: [],
  processing: [],
  completed: [],
  failed: [],
  stats: {
    total_requests: 0,
    successful_calls: 0,
    failed_calls: 0,
    callbacks_requested: 0
  }
};

/**
 * Acquiert un verrou sur la file d'attente
 */
async function acquireLock() {
  const startTime = Date.now();
  
  while (Date.now() - startTime < LOCK_TIMEOUT) {
    try {
      // Vérifier si le verrou existe déjà
      const stats = await fs.stat(LOCK_FILE).catch(() => null);
      if (stats) {
        // Vérifier si le verrou est trop ancien (> 30 secondes = processus mort)
        if (Date.now() - stats.mtime.getTime() > 30000) {
          console.warn('⚠️ Verrou expiré détecté, suppression...');
          await fs.unlink(LOCK_FILE).catch(() => {});
        } else {
          // Attendre un peu et réessayer
          await new Promise(resolve => setTimeout(resolve, 100));
          continue;
        }
      }
      
      // Créer le verrou
      await fs.writeFile(LOCK_FILE, JSON.stringify({
        pid: process.pid,
        timestamp: Date.now()
      }));
      
      return true;
    } catch (error) {
      if (error.code === 'EEXIST') {
        // Un autre processus a créé le verrou en même temps
        await new Promise(resolve => setTimeout(resolve, 100));
        continue;
      }
      throw error;
    }
  }
  
  throw new Error('Impossible d\'acquérir le verrou sur la file d\'attente');
}

/**
 * Libère le verrou sur la file d'attente
 */
async function releaseLock() {
  try {
    await fs.unlink(LOCK_FILE);
  } catch (error) {
    // Ignorer si le fichier n'existe pas
    if (error.code !== 'ENOENT') {
      console.warn('Erreur lors de la libération du verrou:', error.message);
    }
  }
}

/**
 * Charge la file d'attente depuis le fichier JSON
 */
async function loadQueue() {
  try {
    const data = await fs.readFile(QUEUE_FILE, 'utf8');
    const queue = JSON.parse(data);
    
    // Vérifier la structure et ajouter les champs manquants
    const mergedQueue = { ...DEFAULT_QUEUE, ...queue };
    mergedQueue.stats = { ...DEFAULT_QUEUE.stats, ...queue.stats };
    
    return mergedQueue;
  } catch (error) {
    if (error.code === 'ENOENT') {
      // Fichier n'existe pas, créer la structure par défaut
      await saveQueue(DEFAULT_QUEUE);
      return DEFAULT_QUEUE;
    }
    throw error;
  }
}

/**
 * Sauvegarde la file d'attente dans le fichier JSON
 */
async function saveQueue(queue) {
  const data = JSON.stringify(queue, null, 2);
  await fs.writeFile(QUEUE_FILE, data, 'utf8');
}

/**
 * Exécute une opération sur la file d'attente avec verrouillage
 */
async function withQueueLock(operation) {
  await acquireLock();
  try {
    const queue = await loadQueue();
    const result = await operation(queue);
    await saveQueue(queue);
    return result;
  } finally {
    await releaseLock();
  }
}

/**
 * Ajoute une nouvelle demande à la file d'attente
 */
async function addToQueue(webhookData, scheduledFor = null) {
  return await withQueueLock(async (queue) => {
    const id = uuidv4();
    const now = new Date();
    const scheduled = scheduledFor || getNextBusinessTime();
    
    const queueItem = {
      id,
      created_at: now.toISOString(),
      scheduled_for: scheduled.toISOString(),
      type: 'initial',
      attempts: {
        total: 0,
        technical_failures: 0,
        callback_requests: 0
      },
      last_result: null,
      history: [],
      data: webhookData
    };
    
    queue.pending.push(queueItem);
    queue.stats.total_requests++;
    
    console.log(`✅ Demande ajoutée à la file d'attente:`, {
      id,
      scheduled_for: scheduled.toISOString(),
      reference: webhookData.order?.reference
    });
    
    return { id, scheduled_for: scheduled };
  });
}

/**
 * Récupère les éléments prêts à être traités
 */
async function getReadyItems() {
  return await withQueueLock(async (queue) => {
    const now = new Date();
    const readyItems = queue.pending.filter(item => 
      new Date(item.scheduled_for) <= now
    );
    
    return readyItems;
  });
}

/**
 * Marque un élément comme en cours de traitement
 */
async function markAsProcessing(itemId) {
  return await withQueueLock(async (queue) => {
    const itemIndex = queue.pending.findIndex(item => item.id === itemId);
    if (itemIndex === -1) {
      throw new Error(`Item ${itemId} non trouvé dans pending`);
    }
    
    const item = queue.pending.splice(itemIndex, 1)[0];
    item.status = 'processing';
    item.processing_started_at = new Date().toISOString();
    
    queue.processing.push(item);
    
    return item;
  });
}

/**
 * Met à jour le résultat d'un appel et gère la reprogrammation
 */
async function updateCallResult(itemId, callResult) {
  return await withQueueLock(async (queue) => {
    const itemIndex = queue.processing.findIndex(item => item.id === itemId);
    if (itemIndex === -1) {
      throw new Error(`Item ${itemId} non trouvé dans processing`);
    }
    
    const item = queue.processing.splice(itemIndex, 1)[0];
    const now = new Date();
    
    // Ajouter à l'historique
    const historyEntry = {
      timestamp: now.toISOString(),
      conversation_id: callResult.conversationId,
      call_status: callResult.call_status,
      result: callResult.result,
      reason: callResult.reason || null
    };
    
    item.history.push(historyEntry);
    item.attempts.total++;
    item.last_result = callResult.result;
    
    // Déterminer l'action selon le résultat
    const { result } = callResult;
    
    if (result === 'Accepté' || result === 'Refusé') {
      // Terminé définitivement
      item.status = 'completed';
      item.completed_at = now.toISOString();
      queue.completed.push(item);
      queue.stats.successful_calls++;
      
      console.log(`✅ Demande terminée:`, {
        id: itemId,
        result,
        reference: item.data.order?.reference
      });
      
      return { status: 'completed', item };
    }
    else if (result === 'En attente de rappel') {
      // Programmer un rappel
      item.attempts.callback_requests++;
      
      if (item.attempts.callback_requests >= 3) {
        // Trop de rappels demandés
        item.status = 'failed';
        item.failed_at = now.toISOString();
        item.failure_reason = 'Trop de rappels demandés (3 max)';
        queue.failed.push(item);
        queue.stats.failed_calls++;
        
        console.log(`❌ Demande échouée - trop de rappels:`, {
          id: itemId,
          reference: item.data.order?.reference
        });
        
        return { status: 'failed', item };
      } else {
        // Reprogrammer
        const delayMinutes = getRetryDelay('callback_requested', item.attempts.callback_requests);
        const nextAttempt = getNextBusinessTime(now, delayMinutes);
        
        item.scheduled_for = nextAttempt.toISOString();
        item.type = 'callback';
        item.status = 'pending';
        
        queue.pending.push(item);
        queue.stats.callbacks_requested++;
        
        console.log(`🔄 Rappel programmé:`, {
          id: itemId,
          next_attempt: nextAttempt.toISOString(),
          attempt: item.attempts.callback_requests,
          reference: item.data.order?.reference
        });
        
        return { status: 'rescheduled', item, next_attempt: nextAttempt };
      }
    }
    else {
      // Échec technique (no_answer, voicemail, failed)
      item.attempts.technical_failures++;
      
      if (item.attempts.technical_failures >= 3) {
        // Trop d'échecs techniques
        item.status = 'failed';
        item.failed_at = now.toISOString();
        item.failure_reason = 'Trop d\'échecs techniques (3 max)';
        queue.failed.push(item);
        queue.stats.failed_calls++;
        
        console.log(`❌ Demande échouée - trop d'échecs:`, {
          id: itemId,
          result,
          reference: item.data.order?.reference
        });
        
        return { status: 'failed', item };
      } else {
        // Reprogrammer retry
        const delayMinutes = getRetryDelay(result, item.attempts.technical_failures);
        const nextAttempt = getNextBusinessTime(now, delayMinutes);
        
        item.scheduled_for = nextAttempt.toISOString();
        item.type = 'retry';
        item.status = 'pending';
        
        queue.pending.push(item);
        
        console.log(`🔄 Retry programmé:`, {
          id: itemId,
          result,
          next_attempt: nextAttempt.toISOString(),
          attempt: item.attempts.technical_failures,
          reference: item.data.order?.reference
        });
        
        return { status: 'rescheduled', item, next_attempt: nextAttempt };
      }
    }
  });
}

/**
 * Récupère les statistiques de la file d'attente
 */
async function getQueueStats() {
  return await withQueueLock(async (queue) => {
    return {
      pending: queue.pending.length,
      processing: queue.processing.length,
      completed: queue.completed.length,
      failed: queue.failed.length,
      stats: queue.stats,
      next_items: queue.pending
        .sort((a, b) => new Date(a.scheduled_for) - new Date(b.scheduled_for))
        .slice(0, 5)
        .map(item => ({
          id: item.id,
          reference: item.data.order?.reference,
          scheduled_for: item.scheduled_for,
          type: item.type,
          attempts: item.attempts.total
        }))
    };
  });
}

/**
 * Nettoie les anciens éléments terminés (> 7 jours)
 */
async function cleanupOldItems() {
  return await withQueueLock(async (queue) => {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    
    const initialCompleted = queue.completed.length;
    const initialFailed = queue.failed.length;
    
    queue.completed = queue.completed.filter(item => 
      new Date(item.completed_at || item.created_at) > sevenDaysAgo
    );
    
    queue.failed = queue.failed.filter(item => 
      new Date(item.failed_at || item.created_at) > sevenDaysAgo
    );
    
    const cleanedCompleted = initialCompleted - queue.completed.length;
    const cleanedFailed = initialFailed - queue.failed.length;
    
    if (cleanedCompleted > 0 || cleanedFailed > 0) {
      console.log(`🧹 Nettoyage: ${cleanedCompleted} completed + ${cleanedFailed} failed supprimés`);
    }
    
    return { cleanedCompleted, cleanedFailed };
  });
}

module.exports = {
  addToQueue,
  getReadyItems,
  markAsProcessing,
  updateCallResult,
  getQueueStats,
  cleanupOldItems
};