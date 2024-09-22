import { CONSTANTS } from '../config/constants.js';
import { createHash } from 'crypto';
import { Context } from '@devvit/public-api';

type PartialContext = Partial<Context>;

export async function validateApiKey(apiKey: string): Promise<boolean> {
  try {
    const response = await fetch(`${CONSTANTS.GEMINI_API_TEST_ENDPOINT}?key=${apiKey}`);
    return response.ok;
  } catch (error) {
    console.error('Error validating API key:', error);
    return false;
  }
}

export async function checkAndUpdateApiKey(context: PartialContext): Promise<boolean> {
  const apiKey = await context.settings?.get('api_key') as string;
  const storedHash = await context.redis?.get('api_key_hash');
  
  if (!apiKey) return false;

  const newHash = createHash('sha256').update(apiKey).digest('hex');
  
  if (newHash !== storedHash) {
    await context.redis?.set('api_key_hash', newHash);
    return true;
  }
  
  return false;
}