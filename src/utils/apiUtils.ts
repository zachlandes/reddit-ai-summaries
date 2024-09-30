import { CONSTANTS } from '../config/constants.js';
import { Context } from '@devvit/public-api';
import { sha256 } from './hashUtils.js';

type PartialContext = Partial<Context>;

/**
 * Validates the API key by checking if the validation status is 'valid' in Redis.
 * If not, it fetches the API key from the settings and validates it.
 * @param {string} apiKey - The API key to validate.
 * @param {PartialContext} context - The application context.
 * @returns {Promise<boolean>} - Returns true if the API key is valid, false otherwise.
 */
export async function validateApiKey(apiKey: string, context: PartialContext): Promise<boolean> {
  const validationStatus = await context.redis?.get(CONSTANTS.API_KEY_VALIDATION_KEY);
  if (validationStatus === 'valid') {
    return true;
  }

  try {
    const response = await fetch(`${CONSTANTS.GEMINI_API_TEST_ENDPOINT}?key=${apiKey}`);
    const isValid = response.ok;
    if (isValid) {
      const expirationDate = new Date(Date.now() + CONSTANTS.API_KEY_VALIDATION_TTL * 1000);
      await context.redis?.set(CONSTANTS.API_KEY_VALIDATION_KEY, 'valid', { expiration: expirationDate });
    }
    return isValid;
  } catch (error) {
    console.error('Error validating API key:', error);
    return false;
  }
}

export async function checkAndUpdateApiKey(context: PartialContext): Promise<{ changed: boolean; valid: boolean }> {
  const apiKey = await context.settings?.get('api_key') as string;
  const storedHash = await context.redis?.get('api_key_hash');
  
  if (!apiKey) return { changed: false, valid: false };

  const newHash = sha256(apiKey);
  const changed = newHash !== storedHash;
  
  const isValid = await validateApiKey(apiKey, context);
  
  if (changed && isValid) {
    await context.redis?.set('api_key_hash', newHash);
    const expirationDate = new Date(Date.now() + CONSTANTS.API_KEY_VALIDATION_TTL * 1000);
    await context.redis?.set(CONSTANTS.API_KEY_VALIDATION_KEY, 'valid', { expiration: expirationDate });
  }
  
  return { changed, valid: isValid };
}

/**
 * Invalidates the API key validation status in Redis.
 * @param {PartialContext} context - The application context.
 * @returns {Promise<void>} - Returns nothing.
 */
export async function invalidateApiKeyValidation(context: PartialContext): Promise<void> {
  await context.redis?.del(CONSTANTS.API_KEY_VALIDATION_KEY);
}