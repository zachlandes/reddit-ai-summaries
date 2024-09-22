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

    const systemPrompt = `You are an unbiased summarizer of links on Reddit posts. You will be asked to summarize a variety of links, from news to corporate websites. You should always provide an unbiased summary of the linked page content. You will be given the title and text body of the linked page. Make sure to summarize the content, do not reproduce it. If the content is very short, then your summary should be correspondingly short. Your summary will appear in a reddit comment, and thus must be brief. However, for longer texts, you may provide a summary of several paragraphs in length. Your entire response must be less than 10,000 characters. If the content is in another language, provide your summary in that language and then provide your summary in English. When summarizing in another language, be sure to use the same variety of that language as is used in the content, for example if the content is in Brazilian Portuguese, the summary should be in Brazilian Portuguese and not in Portugal Portuguese. Remember: always include an English summary, and ALSO include a summary in the language of the content ONLY IF that content is primarily in another language. For styling, you can include the title "Link Summary". Always use bullet points for the summary.`;

    const prompt = `${systemPrompt}\n\nTitle: "${title}"\n\nContent: "${content}"`;
    console.debug(`Prompt for Gemini: ${prompt}`);
    const result = await geminiModel.generateContent(prompt);
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

