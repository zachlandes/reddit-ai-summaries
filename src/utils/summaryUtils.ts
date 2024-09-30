import { Context } from '@devvit/public-api';
import { TokenBucket, tokenBucketInstance } from './tokenBucket.js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { CONSTANTS } from '../config/constants.js';

type PartialContext = Partial<Context>;

export async function summarizeContent(
  url: string,
  title: string,
  content: string,
  context: PartialContext,
  apiKey: string,
  temperature: number = CONSTANTS.DEFAULT_TEMPERATURE,
  includeScriptlessLink: boolean = true
): Promise<string> {
  console.info('Starting summary generation...');
  
  // Estimate input tokens
  const inputTokens = TokenBucket.estimateTokens(CONSTANTS.SUMMARY_SYSTEM_PROMPT + title + content);
  
  // Estimate potential output tokens (let's assume a maximum summary length)
  const maxSummaryTokens = TokenBucket.estimateMaxTokens(CONSTANTS.MAX_SUMMARY_LENGTH);
  
  // Total estimated tokens
  const totalEstimatedTokens = inputTokens + maxSummaryTokens;
  
  console.debug(`Estimated total tokens required: ${totalEstimatedTokens}`);

  // Check for available request slot with a timeout
  console.debug('Checking for available request slot...');
  try {
    const requestSlotAvailable = await tokenBucketInstance.checkRequestAvailability(context, CONSTANTS.REQUEST_SLOT_TIMEOUT);
    if (!requestSlotAvailable) {
      console.warn('Request slot not available within timeout period.');
      throw new Error('RequestSlotUnavailable');
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'DailyRequestLimitReached') {
      throw error; // Propagate this error to be handled in processQueue
    }
    console.warn('Request slot not available within timeout period.');
    throw new Error('RequestSlotUnavailable');
  }

  // Wait for available tokens with a timeout
  console.debug('Waiting for available tokens...');
  const tokensAvailable = await tokenBucketInstance.waitForTokens(totalEstimatedTokens, context, CONSTANTS.TOKEN_WAIT_TIMEOUT);
  if (!tokensAvailable) {
    console.warn('Tokens not available within timeout period.');
    throw new Error('TokensUnavailable');
  }

  try {
    const summary = await generateSummaryWithGemini(url, title, content, apiKey, temperature);
    
    // Release unused tokens
    const actualOutputTokens = TokenBucket.estimateTokens(summary);
    const unusedTokens = maxSummaryTokens - actualOutputTokens;
    if (unusedTokens > 0) {
      await tokenBucketInstance.releaseTokens(unusedTokens, context);
    }

    if (includeScriptlessLink) {
      return `${summary}\n\nScriptless version: ${url}`;
    }
    
    return summary;
  } catch (error) {
    // Release all reserved output tokens on error
    await tokenBucketInstance.releaseTokens(maxSummaryTokens, context);
    throw error;
  }
}

async function generateSummaryWithGemini(
  url: string,
  title: string,
  content: string,
  apiKey: string,
  temperature: number
): Promise<string> {
  console.debug('Calling Gemini API for summary generation...');
  try {
    const model = new GoogleGenerativeAI(apiKey);
    const geminiModel = model.getGenerativeModel({ model: "gemini-1.5-flash" });

    const systemPrompt = CONSTANTS.SUMMARY_SYSTEM_PROMPT;
    const summarizingPrompt = `Summarize the following web content from ${url}:
Title: """${title}"""
Text: """${content}"""`;

    const prompt = `${systemPrompt}\n\n${summarizingPrompt}`;
    console.debug(`Prompt for Gemini: ${prompt}`);
    
    const result = await geminiModel.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: temperature,
      },
    });
    
    const response = await result.response;
    const summary = response.text();

    if (!summary) {
      console.error('Gemini API returned an empty summary.');
      throw new Error('Failed to generate summary');
    }

    console.debug('Received summary from Gemini API.');
    return summary + '\n\n*I am an AI-powered bot and this summary was created automatically. Questions or concerns? Contact us. Want AI summaries for your own sub? Get them here*'; //TODO: add links
  } catch (error) {
    if (error instanceof Error && error.message.includes('PERMISSION_DENIED')) {
      console.error('Gemini API authentication failed. Please check your API key and permissions:', error);
      throw new Error('GeminiAuthenticationError');
    } else {
      console.error('Gemini summary generation failed:', error);
      throw error; // Propagate the error to be handled in processQueue
    }
  }
}

