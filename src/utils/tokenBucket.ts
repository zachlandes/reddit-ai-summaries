import { Context } from '@devvit/public-api';
import { DEFAULT_GEMINI_LIMITS } from '../config/geminiLimits.js';

type PartialContext = Partial<Context>;

export class TokenBucket {
  private static readonly TOKENS_KEY = 'tokens';
  private static readonly LAST_REFILL_KEY = 'last_refill';
  private static readonly REQUESTS_TODAY_KEY = 'requests_today';
  private static readonly LAST_REQUEST_KEY = 'last_request';

  private tokensPerMinute: number;
  private requestsPerMinute: number;
  private requestsPerDay: number;

  constructor() {
    this.tokensPerMinute = DEFAULT_GEMINI_LIMITS.TOKENS_PER_MINUTE;
    this.requestsPerMinute = DEFAULT_GEMINI_LIMITS.REQUESTS_PER_MINUTE;
    this.requestsPerDay = DEFAULT_GEMINI_LIMITS.REQUESTS_PER_DAY;
  }

  updateLimits(tokensPerMinute: number, requestsPerMinute: number, requestsPerDay: number) {
    this.tokensPerMinute = tokensPerMinute;
    this.requestsPerMinute = requestsPerMinute;
    this.requestsPerDay = requestsPerDay;
  }

  private async refill(context: PartialContext): Promise<void> {
    console.debug('Refilling tokens...');
    const now = Date.now();
    const lastRefill = parseInt(await context.redis?.get(TokenBucket.LAST_REFILL_KEY) || '0');
    const timePassed = (now - lastRefill) / 1000; // in seconds
    const newTokens = timePassed * (this.tokensPerMinute / 60);
    const currentTokens = parseFloat(await context.redis?.get(TokenBucket.TOKENS_KEY) || '0');
    const updatedTokens = Math.min(currentTokens + newTokens, this.tokensPerMinute);
    
    console.debug(`Adding ${newTokens.toFixed(2)} tokens. Total tokens now: ${updatedTokens.toFixed(2)}`);
    await context.redis?.set(TokenBucket.TOKENS_KEY, updatedTokens.toString());
    await context.redis?.set(TokenBucket.LAST_REFILL_KEY, now.toString());
  }

  async waitForTokens(tokens: number, context: PartialContext): Promise<void> {
    console.debug(`Waiting for ${tokens} tokens...`);
    while (true) {
      await this.refill(context);
      const currentTokens = parseFloat(await context.redis?.get(TokenBucket.TOKENS_KEY) || '0');
      console.debug(`Current tokens available: ${currentTokens}`);
      if (currentTokens >= tokens) {
        // Reserve tokens instead of immediately deducting
        const reservedTokens = currentTokens - tokens;
        await context.redis?.set(TokenBucket.TOKENS_KEY, reservedTokens.toString());
        console.debug(`Reserved ${tokens} tokens. Tokens left: ${reservedTokens}`);
        break;
      }
      console.debug('Not enough tokens. Waiting...');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  async waitForRequest(context: PartialContext): Promise<void> {
    console.debug('Waiting for available request slot...');
    while (true) {
      const now = Date.now();
      const lastRequest = parseInt(await context.redis?.get(TokenBucket.LAST_REQUEST_KEY) || '0');
      const requestsToday = parseInt(await context.redis?.get(TokenBucket.REQUESTS_TODAY_KEY) || '0');
      
      if (now - lastRequest >= 60000 / this.requestsPerMinute) {
        if (requestsToday < this.requestsPerDay) {
          await context.redis?.set(TokenBucket.REQUESTS_TODAY_KEY, (requestsToday + 1).toString());
          await context.redis?.set(TokenBucket.LAST_REQUEST_KEY, now.toString());
          console.debug(`Allocated request slot. Requests today: ${requestsToday + 1}`);
          break;
        } else {
          console.warn('Daily request limit reached.');
        }
      } else {
        console.debug('Request slot not available yet.');
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  async resetDailyRequests(context: PartialContext): Promise<void> {
    console.info('Resetting daily requests and tokens...');
    await context.redis?.set(TokenBucket.REQUESTS_TODAY_KEY, '0');
    console.debug('Daily requests reset to 0.');
    // Optionally reset tokens as well
    await context.redis?.set(TokenBucket.TOKENS_KEY, this.tokensPerMinute.toString());
    console.debug(`Tokens reset to ${this.tokensPerMinute}.`);
  }

  async releaseTokens(tokens: number, context: PartialContext): Promise<void> {
    const currentTokens = parseFloat(await context.redis?.get(TokenBucket.TOKENS_KEY) || '0');
    const updatedTokens = Math.min(currentTokens + tokens, this.tokensPerMinute);
    await context.redis?.set(TokenBucket.TOKENS_KEY, updatedTokens.toString());
    console.debug(`Released ${tokens} tokens. Total tokens now: ${updatedTokens}`);
  }

  static estimateTokens(text: string): number {
    // A more accurate estimation method
    // Gemini uses about 1 token per 4 characters for English text
    return Math.ceil(text.length / 4);
  }

  static estimateMaxTokens(characterLimit: number): number {
    // Estimate the maximum number of tokens for a given character limit
    return Math.ceil(characterLimit / 4);
  }

  async resetBucket(context: PartialContext): Promise<void> {
    console.info('Resetting token bucket...');
    await context.redis?.set(TokenBucket.TOKENS_KEY, this.tokensPerMinute.toString());
    await context.redis?.set(TokenBucket.REQUESTS_TODAY_KEY, '0');
    await context.redis?.set(TokenBucket.LAST_REFILL_KEY, Date.now().toString());
    await context.redis?.set(TokenBucket.LAST_REQUEST_KEY, '0');
    console.debug('Token bucket reset completed.');
  }
}

// Create and export a single instance
export const tokenBucketInstance = new TokenBucket();