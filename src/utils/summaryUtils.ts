import { Context } from '@devvit/public-api';
import { tokenBucket } from './tokenBucket.js';
import { GoogleGenerativeAI } from '@google/generative-ai';

type PartialContext = Partial<Context>;

export async function summarizeContent(
  title: string,
  content: string,
  context: PartialContext,
  apiKey?: string
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

  // Ensure API key is provided
  if (!apiKey) {
    console.error('API key is required for summary generation.');
    throw new Error('API key is required for summary generation.');
  }

  // Generate the summary using Gemini
  console.debug('Generating summary with Gemini API...');
  const summary = await generateSummaryWithGemini(title, content, apiKey);
  console.info('Summary generation completed.');
  
  return summary;
}

async function generateSummaryWithGemini(
  title: string,
  content: string,
  apiKey: string
): Promise<string> {
  console.debug('Calling Gemini API for summary generation...');
  try {
    const model = new GoogleGenerativeAI(apiKey);
    const geminiModel = model.getGenerativeModel({ model: "gemini-1.5-flash" });

    const prompt = `Summarize the following web content. If the content is a news article, include the date in the summary. Web content:\n\nTitle:\n"${title}"\n\nContent:\n"${content}"`;
    console.debug(`Prompt for Gemini: ${prompt}`);
    const result = await geminiModel.generateContent(prompt);
    const response = await result.response;
    const summary = response.text();

    if (!summary) {
      console.error('Gemini API returned an empty summary.');
      throw new Error('Failed to generate summary');
    }

    console.debug('Received summary from Gemini API.');
    return summary + '\n\n*Like these summaries? Tip us!*';
  } catch (error) {
    console.error('Gemini summary generation failed:', error);
    throw error; // Propagate the error to be handled in processQueue
  }
}

