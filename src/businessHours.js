/**
 * Gestion des horaires d'ouverture français
 * Lundi à Vendredi : 9h-12h et 14h-17h (Europe/Paris)
 */

const moment = require('moment-timezone');

/**
 * Vérifie si on est actuellement dans les horaires d'ouverture
 * @returns {boolean}
 */
function isBusinessHours() {
  const now = moment().tz('Europe/Paris');
  const day = now.day(); // 0=Dimanche, 1=Lundi, ..., 6=Samedi
  const hour = now.hour();
  
  // Lundi à Vendredi (1-5)
  if (day >= 1 && day <= 5) {
    // 9h-12h ou 14h-17h
    return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 17);
  }
  
  return false;
}

/**
 * Calcule le prochain créneau d'ouverture
 * @param {Date} fromDate - Date de référence (optionnel, défaut = maintenant)
 * @param {number} additionalMinutes - Minutes supplémentaires à ajouter (optionnel)
 * @returns {Date}
 */
function getNextBusinessTime(fromDate = null, additionalMinutes = 0) {
  let targetTime = fromDate ? moment(fromDate).tz('Europe/Paris') : moment().tz('Europe/Paris');
  
  // Ajouter les minutes supplémentaires
  if (additionalMinutes > 0) {
    targetTime.add(additionalMinutes, 'minutes');
  }
  
  // Si c'est déjà dans les horaires d'ouverture et pas de délai ajouté
  if (additionalMinutes === 0 && isBusinessHoursAt(targetTime)) {
    return targetTime.toDate();
  }
  
  // Trouver le prochain créneau d'ouverture
  let attempts = 0;
  while (attempts < 14) { // Maximum 2 semaines de recherche
    const day = targetTime.day();
    const hour = targetTime.hour();
    const minute = targetTime.minute();
    
    // Lundi à Vendredi
    if (day >= 1 && day <= 5) {
      // Avant 9h → 9h00
      if (hour < 9) {
        targetTime.hour(9).minute(0).second(0);
        break;
      }
      // Entre 9h et 12h → OK si pas déjà passé
      else if (hour >= 9 && hour < 12) {
        if (additionalMinutes === 0) {
          break;
        }
        // Sinon continuer vers 14h
        targetTime.hour(14).minute(0).second(0);
        break;
      }
      // Entre 12h et 14h → 14h00
      else if (hour >= 12 && hour < 14) {
        targetTime.hour(14).minute(0).second(0);
        break;
      }
      // Entre 14h et 17h → OK si pas déjà passé
      else if (hour >= 14 && hour < 17) {
        if (additionalMinutes === 0) {
          break;
        }
        // Sinon aller au lendemain 9h
        targetTime.add(1, 'day').hour(9).minute(0).second(0);
      }
      // Après 17h → Lendemain 9h
      else {
        targetTime.add(1, 'day').hour(9).minute(0).second(0);
      }
    }
    // Weekend → Lundi 9h
    else {
      const daysUntilMonday = day === 0 ? 1 : (8 - day); // Dimanche = 1 jour, Samedi = 2 jours
      targetTime.add(daysUntilMonday, 'days').hour(9).minute(0).second(0);
      break;
    }
    
    attempts++;
  }
  
  return targetTime.toDate();
}

/**
 * Vérifie si une date donnée est dans les horaires d'ouverture
 * @param {moment.Moment} momentDate - Date au format moment
 * @returns {boolean}
 */
function isBusinessHoursAt(momentDate) {
  const day = momentDate.day();
  const hour = momentDate.hour();
  
  if (day >= 1 && day <= 5) {
    return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 17);
  }
  
  return false;
}

/**
 * Calcule le délai avant le prochain rappel selon le type de résultat
 * @param {string} result - Type de résultat (callback_requested, no_answer, failed)
 * @param {number} attemptCount - Numéro de la tentative (1, 2, 3...)
 * @returns {number} Délai en minutes
 */
function getRetryDelay(result, attemptCount) {
  const delays = {
    'callback_requested': [120, 240, 1440], // 2h, 4h, 1 jour
    'no_answer': [30, 60, 120], // 30min, 1h, 2h
    'voicemail': [30, 60, 120], // 30min, 1h, 2h
    'failed': [15, 30, 60] // 15min, 30min, 1h
  };
  
  const delayArray = delays[result] || delays['failed'];
  const delayIndex = Math.min(attemptCount - 1, delayArray.length - 1);
  
  return delayArray[delayIndex];
}

/**
 * Formate une date pour l'affichage
 * @param {Date} date 
 * @returns {string}
 */
function formatBusinessTime(date) {
  return moment(date).tz('Europe/Paris').format('DD/MM/YYYY HH:mm');
}

module.exports = {
  isBusinessHours,
  getNextBusinessTime,
  getRetryDelay,
  formatBusinessTime
};