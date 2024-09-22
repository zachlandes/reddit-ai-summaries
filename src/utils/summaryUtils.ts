import { Context } from '@devvit/public-api';
import { tokenBucket } from './tokenBucket.js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { CONSTANTS } from '../config/constants.js';

type PartialContext = Partial<Context>;

export async function summarizeContent(
  url: string,
  title: string,
  content: string,
  context: PartialContext,
  apiKey: string,
  temperature: number = CONSTANTS.DEFAULT_TEMPERATURE
): Promise<string> {
  console.info('Starting summary generation...');
  // Wait for available request slot
  console.debug('Waiting for available request slot...');
  await tokenBucket.waitForRequest(context);

  // Estimate tokens (approx. 4 characters per token for English text)
  const estimatedTokens = Math.ceil((title.length + content.length) / 4);
  console.debug(`Estimated tokens required: ${estimatedTokens}`);

  // Wait for available tokens
  console.debug('Waiting for available tokens...');
  await tokenBucket.waitForTokens(estimatedTokens, context);

  // Generate the summary using Gemini
  console.debug('Generating summary with Gemini API...');
  const summary = await generateSummaryWithGemini(url, title, content, apiKey, temperature);
  console.info('Summary generation completed.');
  
  return summary;
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

