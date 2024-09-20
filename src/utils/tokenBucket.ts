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
    const now = Date.now();
    const lastRefill = parseInt(await context.redis?.get(TokenBucket.LAST_REFILL_KEY) || '0');
    const timePassed = (now - lastRefill) / 1000; // in seconds
    const newTokens = timePassed * (this.tokensPerMinute / 60);
    const currentTokens = parseFloat(await context.redis?.get(TokenBucket.TOKENS_KEY) || '0');
    const updatedTokens = Math.min(currentTokens + newTokens, this.tokensPerMinute);
    
    await context.redis?.set(TokenBucket.TOKENS_KEY, updatedTokens.toString());
    await context.redis?.set(TokenBucket.LAST_REFILL_KEY, now.toString());
  }

  async waitForTokens(tokens: number, context: PartialContext): Promise<void> {
    while (true) {
      await this.refill(context);
      const currentTokens = parseFloat(await context.redis?.get(TokenBucket.TOKENS_KEY) || '0');
      if (currentTokens >= tokens) {
        await context.redis?.set(TokenBucket.TOKENS_KEY, (currentTokens - tokens).toString());
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  async waitForRequest(context: PartialContext): Promise<void> {
    while (true) {
      const now = Date.now();
      const lastRequest = parseInt(await context.redis?.get(TokenBucket.LAST_REQUEST_KEY) || '0');
      const requestsToday = parseInt(await context.redis?.get(TokenBucket.REQUESTS_TODAY_KEY) || '0');
      
      if (now - lastRequest >= 60000 / this.requestsPerMinute) {
        if (requestsToday < this.requestsPerDay) {
          await context.redis?.set(TokenBucket.REQUESTS_TODAY_KEY, (requestsToday + 1).toString());
          await context.redis?.set(TokenBucket.LAST_REQUEST_KEY, now.toString());
          break;
        }
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  async resetDailyRequests(context: PartialContext): Promise<void> {
    await context.redis?.set(TokenBucket.REQUESTS_TODAY_KEY, '0');
    // Optionally reset tokens as well
    await context.redis?.set(TokenBucket.TOKENS_KEY, this.tokensPerMinute.toString());
  }
}

export const tokenBucket = new TokenBucket();