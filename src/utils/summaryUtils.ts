import { Context } from '@devvit/public-api';
import { tokenBucket } from './tokenBucket.js';
import { GoogleGenerativeAI } from '@google/generative-ai';

type PartialContext = Partial<Context>;

export async function summarizeContent(title: string, content: string, context: PartialContext): Promise<string> {
  // Wait for available request slot
  await tokenBucket.waitForRequest(context);

  // Estimate tokens (approx. 4 characters per token for English text)
  const estimatedTokens = Math.ceil((title.length + content.length) / 4);

  // Wait for available tokens
  await tokenBucket.waitForTokens(estimatedTokens, context);

  // Generate the summary using Gemini
  const summary = await generateSummaryWithGemini(title, content, context);

  return summary;
}

async function generateSummaryWithGemini(title: string, content: string, context: PartialContext): Promise<string> {
  try {
    const apiKey = await context.settings?.get('api_key');
    if (!apiKey || typeof apiKey !== 'string') {
      throw new Error('Invalid or missing API key');
    }

    const model = new GoogleGenerativeAI(apiKey);
    const geminiModel = model.getGenerativeModel({ model: "gemini-1.5-flash" });

    const prompt = `Summarize the following web content. If the article is a news article, include the date in the summary. Web content:\n\nTitle:\n"${title}"\n\nContent:\n"${content}"`;
    const result = await geminiModel.generateContent(prompt);
    const response = await result.response;
    const summary = response.text();

    if (!summary) {
      throw new Error('Failed to generate summary');
    }

    return summary;
  } catch (error) {
    console.error('Gemini summary generation failed:', error);
    throw error; // Propagate the error to be handled in processQueue
  }
}

