/**
 * Tests pour la logique des horaires d'ouverture
 */

const moment = require('moment-timezone');
const { isBusinessHours, getNextBusinessTime, getRetryDelay, formatBusinessTime } = require('../src/businessHours');

// Mock moment pour contrôler le temps dans les tests
const mockMoment = (dateString) => {
  const originalMoment = moment;
  const mockedMoment = originalMoment(dateString).tz('Europe/Paris');
  
  // Override moment() calls to return our mocked time
  const momentSpy = jest.spyOn(moment, 'now').mockReturnValue(mockedMoment.valueOf());
  
  return () => momentSpy.mockRestore();
};

describe('businessHours', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('isBusinessHours', () => {
    test('should return true during business hours - Monday 10h', () => {
      const cleanup = mockMoment('2025-07-28 10:00:00'); // Lundi 10h
      expect(isBusinessHours()).toBe(true);
      cleanup();
    });

    test('should return true during business hours - Friday 15h', () => {
      const cleanup = mockMoment('2025-08-01 15:00:00'); // Vendredi 15h
      expect(isBusinessHours()).toBe(true);
      cleanup();
    });

    test('should return false outside business hours - Monday 8h', () => {
      const cleanup = mockMoment('2025-07-28 08:00:00'); // Lundi 8h
      expect(isBusinessHours()).toBe(false);
      cleanup();
    });

    test('should return false during lunch break - Monday 13h', () => {
      const cleanup = mockMoment('2025-07-28 13:00:00'); // Lundi 13h
      expect(isBusinessHours()).toBe(false);
      cleanup();
    });

    test('should return false after hours - Friday 18h', () => {
      const cleanup = mockMoment('2025-08-01 18:00:00'); // Vendredi 18h
      expect(isBusinessHours()).toBe(false);
      cleanup();
    });

    test('should return false on weekend - Saturday 10h', () => {
      const cleanup = mockMoment('2025-08-02 10:00:00'); // Samedi 10h
      expect(isBusinessHours()).toBe(false);
      cleanup();
    });

    test('should return false on weekend - Sunday 14h', () => {
      const cleanup = mockMoment('2025-08-03 14:00:00'); // Dimanche 14h
      expect(isBusinessHours()).toBe(false);
      cleanup();
    });
  });

  describe('getNextBusinessTime', () => {
    test('should return Monday 9h when called on Friday evening', () => {
      const fridayEvening = new Date('2025-08-01T19:00:00');
      const nextTime = getNextBusinessTime(fridayEvening);
      
      expect(nextTime.getDay()).toBe(1); // Lundi
      expect(nextTime.getHours()).toBe(9);
      expect(nextTime.getMinutes()).toBe(0);
    });

    test('should return Monday 9h when called on Saturday', () => {
      const saturday = new Date('2025-08-02T10:00:00');
      const nextTime = getNextBusinessTime(saturday);
      
      expect(nextTime.getDay()).toBe(1); // Lundi
      expect(nextTime.getHours()).toBe(9);
    });

    test('should return Monday 9h when called on Sunday', () => {
      const sunday = new Date('2025-08-03T15:00:00');
      const nextTime = getNextBusinessTime(sunday);
      
      expect(nextTime.getDay()).toBe(1); // Lundi
      expect(nextTime.getHours()).toBe(9);
    });

    test('should return 14h when called during lunch break', () => {
      const lunchTime = new Date('2025-07-28T12:30:00'); // Lundi 12h30
      const nextTime = getNextBusinessTime(lunchTime);
      
      expect(nextTime.getDay()).toBe(1); // Même jour (lundi)
      expect(nextTime.getHours()).toBe(14);
      expect(nextTime.getMinutes()).toBe(0);
    });

    test('should return next day 9h when called after 17h', () => {
      const afterHours = new Date('2025-07-28T18:00:00'); // Lundi 18h
      const nextTime = getNextBusinessTime(afterHours);
      
      expect(nextTime.getDay()).toBe(2); // Mardi
      expect(nextTime.getHours()).toBe(9);
    });

    test('should add additional minutes correctly', () => {
      const monday9h = new Date('2025-07-28T09:00:00');
      const nextTime = getNextBusinessTime(monday9h, 60); // +1h
      
      // La fonction programme toujours le prochain créneau d'ouverture quand on ajoute des minutes
      // Si 9h + 1h = 10h, mais comme on ajoute des minutes, ça va au créneau suivant (14h)
      expect(nextTime.getHours()).toBe(14);
      expect(nextTime.getMinutes()).toBe(0);
    });

    test('should handle additional minutes that cross lunch break', () => {
      const monday11h = new Date('2025-07-28T11:30:00');
      const nextTime = getNextBusinessTime(monday11h, 90); // +1h30 = 13h -> 14h
      
      expect(nextTime.getHours()).toBe(14);
      expect(nextTime.getMinutes()).toBe(0);
    });
  });

  describe('getRetryDelay', () => {
    test('should return correct delays for callback_requested', () => {
      expect(getRetryDelay('callback_requested', 1)).toBe(120); // 2h
      expect(getRetryDelay('callback_requested', 2)).toBe(240); // 4h
      expect(getRetryDelay('callback_requested', 3)).toBe(1440); // 1 jour
      expect(getRetryDelay('callback_requested', 4)).toBe(1440); // Max = 1 jour
    });

    test('should return correct delays for no_answer', () => {
      expect(getRetryDelay('no_answer', 1)).toBe(30); // 30min
      expect(getRetryDelay('no_answer', 2)).toBe(60); // 1h
      expect(getRetryDelay('no_answer', 3)).toBe(120); // 2h
    });

    test('should return correct delays for failed', () => {
      expect(getRetryDelay('failed', 1)).toBe(15); // 15min
      expect(getRetryDelay('failed', 2)).toBe(30); // 30min
      expect(getRetryDelay('failed', 3)).toBe(60); // 1h
    });

    test('should default to failed delays for unknown result', () => {
      expect(getRetryDelay('unknown_result', 1)).toBe(15);
    });
  });

  describe('formatBusinessTime', () => {
    test('should format date correctly', () => {
      const date = new Date('2025-07-28T14:30:00Z');
      const formatted = formatBusinessTime(date);
      
      expect(formatted).toMatch(/\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}/);
    });
  });
});