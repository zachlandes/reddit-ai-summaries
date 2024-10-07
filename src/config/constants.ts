export const CONSTANTS = {
  GEMINI_API_TEST_ENDPOINT: 'https://generativelanguage.googleapis.com/v1/models',
  GEMINI_API_GENERATE_CONTENT_ENDPOINT: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent',
  RETRY_INTERVAL: 300000, // 5 minutes in milliseconds
  MAX_RETRIES: 1,
  CRON_DAILY_MIDNIGHT: '0 0 * * *',
  CRON_HOURLY: '0 * * * *',
  CRON_EVERY_30_SECONDS: '*/30 * * * * *',
  SUMMARY_SYSTEM_PROMPT: `You are an unbiased and knowledgeable summarizer of links on Reddit posts. You will be asked to summarize a variety of links, from news to corporate websites. You should always provide an unbiased summary of the linked page content. If the content expresses opinions, you may reflect that in the summary. You will be given the title and text body of the linked page. If the content is very short, then your summary should be correspondingly short. However, for longer texts, you may provide a summary of several paragraphs in length. Your entire response must be less than 8,000 characters. If the content is in another language, provide your summary in that language and then provide your summary in English. When summarizing in another language, be sure to use the same variety of that language as is used in the content, for example if the content is in Brazilian Portuguese, the summary should be in Brazilian Portuguese and not in Portugal Portuguese. Remember: always include an English summary, and IF THE CONTENT IS NOT IN ENGLISH, ALSO include a summary in the language of the content. Include the title "Link Summary". Consider breaking summaries into multiple, bulleted paragraphs.`,
  SUMMARIZING_PROMPT: 'Summarize the following web content from {url}:\nTitle: """{title}"""\nText: """{content}"""',
  BOT_FOOTER: '*I am a bot and this summary was created automatically. Get AI summaries for your own sub with just a few [clicks](https://developers.reddit.com/apps/ai-summaries)*', //TODO: add links
  DEFAULT_TEMPERATURE: 1.0,
  MAX_SUMMARY_LENGTH: 8000, // Maximum summary length in characters
  REQUEST_SLOT_TIMEOUT: 60000, // 1 minute in milliseconds
  TOKEN_WAIT_TIMEOUT: 60000, // 1 minute in milliseconds
  RETRY_DELAY: 60000, // 1 minute in milliseconds
  API_KEY_VALIDATION_KEY: 'api_key_validation',
  API_KEY_VALIDATION_TTL: 1800, // 30 minutes in seconds
};