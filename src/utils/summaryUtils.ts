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
  includeArchiveLink: boolean = true
): Promise<string> {
  console.info('Starting summary generation...');
  
  // Estimate input tokens
  const inputTokens = TokenBucket.estimateTokens(CONSTANTS.SUMMARY_SYSTEM_PROMPT + title + content);
  
  // Estimate potential output tokens (let's assume a maximum summary length)
  const maxSummaryTokens = TokenBucket.estimateMaxTokens(CONSTANTS.MAX_SUMMARY_LENGTH);
  
  // Total estimated tokens
  const totalEstimatedTokens = inputTokens + maxSummaryTokens;
  
  console.debug(`Estimated total tokens required: ${totalEstimatedTokens}`);

  // Wait for available tokens
  console.debug('Waiting for available tokens...');
  await tokenBucketInstance.waitForTokens(totalEstimatedTokens, context);

  try {
    const summary = await generateSummaryWithGemini(url, title, content, apiKey, temperature);
    
    // Release unused tokens
    const actualOutputTokens = TokenBucket.estimateTokens(summary);
    const unusedTokens = maxSummaryTokens - actualOutputTokens;
    if (unusedTokens > 0) {
      await tokenBucketInstance.releaseTokens(unusedTokens, context);
    }

    if (includeArchiveLink) {
      return `${summary}\n\nArchived version: ${url}`;
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
    console.error('Gemini summary generation failed:', error);
    throw error; // Propagate the error to be handled in processQueue
  }
}

