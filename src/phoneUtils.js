/**
 * Utilitaires pour normaliser les numéros de téléphone français
 */

/**
 * Normalise un numéro de téléphone français en format international +33
 * @param {string} phoneNumber - Numéro de téléphone français
 * @returns {string} - Numéro normalisé avec +33
 */
function normalizeFrenchPhoneNumber(phoneNumber) {
  if (!phoneNumber || typeof phoneNumber !== 'string') {
    return phoneNumber;
  }

  // Supprimer tous les espaces, tirets, points, parenthèses
  let cleanNumber = phoneNumber.replace(/[\s\-\.\(\)]/g, '');

  // Si le numéro commence déjà par +33, le retourner tel quel
  if (cleanNumber.startsWith('+33')) {
    return cleanNumber;
  }

  // Si le numéro commence par 0033, remplacer par +33
  if (cleanNumber.startsWith('0033')) {
    return '+33' + cleanNumber.substring(4);
  }

  // Si le numéro commence par 33, ajouter le +
  if (cleanNumber.startsWith('33') && cleanNumber.length >= 11) {
    return '+' + cleanNumber;
  }

  // Si le numéro commence par 0 (format français local)
  if (cleanNumber.startsWith('0') && cleanNumber.length === 10) {
    return '+33' + cleanNumber.substring(1);
  }

  // Si c'est un numéro à 9 chiffres (sans le 0 initial)
  if (cleanNumber.length === 9 && /^\d{9}$/.test(cleanNumber)) {
    return '+33' + cleanNumber;
  }

  // Si aucun format reconnu, retourner tel quel
  return phoneNumber;
}

/**
 * Valide qu'un numéro de téléphone français est correct
 * @param {string} phoneNumber - Numéro de téléphone
 * @returns {boolean} - true si valide
 */
function isValidFrenchPhoneNumber(phoneNumber) {
  if (!phoneNumber || typeof phoneNumber !== 'string') {
    return false;
  }

  const normalized = normalizeFrenchPhoneNumber(phoneNumber);
  
  // Vérifier le format +33 suivi de 9 chiffres
  const frenchPhoneRegex = /^\+33[1-9]\d{8}$/;
  return frenchPhoneRegex.test(normalized);
}

module.exports = {
  normalizeFrenchPhoneNumber,
  isValidFrenchPhoneNumber
};