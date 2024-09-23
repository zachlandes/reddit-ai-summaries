import { Devvit, SettingScope, Context, SettingsFormFieldValidatorEvent } from '@devvit/public-api';
import { tokenBucketInstance } from './utils/tokenBucket.js';
import { summarizeContent } from './utils/summaryUtils.js';
import { DEFAULT_GEMINI_LIMITS } from './config/geminiLimits.js';
import { processQueue, cleanupQueue } from './utils/queueProcessor.js';
import { fetchArticleContent, getUniqueToken } from './utils/scrapeUtils.js';
import { validateApiKey, checkAndUpdateApiKey } from './utils/apiUtils.js';
import { CONSTANTS } from './config/constants.js';
//import { sha256 } from './utils/hashUtils.js';

type PartialContext = Partial<Context>;

Devvit.configure({
  redis: true,
  redditAPI: true,
  http: true,
});

Devvit.addSettings([
  {
    type: 'boolean',
    name: 'automatic_mode',
    label: 'Enable Automatic Summarization:',
    defaultValue: true,
  },
  {
    type: 'string',
    name: 'api_key',
    label: 'Enter your Gemini API Key:',
    onValidate: async (event: SettingsFormFieldValidatorEvent<string>, context: Devvit.Context) => {
      const automaticMode = await context.settings.get('automatic_mode');
      if (automaticMode && (!event.value || event.value.trim() === '')) {
        return 'API Key is required when Automatic Summarization is enabled.';
      }
      if (event.value && event.value.trim() !== '') {
        const isValid = await validateApiKey(event.value.trim());
        if (!isValid) {
          return 'Invalid API Key. Please check and try again.';
        }
      }
      return undefined;
    },
  },
  {
    type: 'number',
    name: 'requests_per_minute',
    label: 'Set Maximum Requests per Minute:',
    defaultValue: DEFAULT_GEMINI_LIMITS.REQUESTS_PER_MINUTE,
    onValidate: async ({ value }) => {
      if (typeof value !== 'number' || value < 1) {
        return 'Requests per minute must be a number at least 1';
      }
    },
  },
  {
    type: 'number',
    name: 'tokens_per_minute',
    label: 'Set Maximum Tokens per Minute:',
    defaultValue: DEFAULT_GEMINI_LIMITS.TOKENS_PER_MINUTE,
    onValidate: async ({ value }) => {
      if (typeof value !== 'number' || value < 1) {
        return 'Tokens per minute must be a number at least 1';
      }
    },
  },
  {
    type: 'number',
    name: 'requests_per_day',
    label: 'Set Maximum Requests per Day:',
    defaultValue: DEFAULT_GEMINI_LIMITS.REQUESTS_PER_DAY,
    onValidate: async ({ value }) => {
      if (typeof value !== 'number' || value < 1) {
        return 'Requests per day must be a number at least 1';
      }
    },
  },
  {
    type: 'boolean',
    name: 'include_archive_link',
    label: 'Include Archive Link in Summary:',
    defaultValue: true,
  },
]);

async function isReadyToProcess(context: PartialContext): Promise<boolean> {
  const automaticMode = await context.settings?.get('automatic_mode');
  const apiKey = await context.settings?.get('api_key');
  return Boolean(automaticMode && apiKey && typeof apiKey === 'string' && apiKey.trim() !== '');
}

async function scheduleJob(context: PartialContext, name: string, cron: string, redisKey: string): Promise<void> {
  console.info(`Scheduling ${name} job...`);
  const existingJobId = await context.redis?.get(redisKey);
  
  if (existingJobId) {
    try {
      await context.scheduler?.cancelJob(existingJobId);
      console.debug(`Deleted existing ${name} job with ID: ${existingJobId}`);
    } catch (error) {
      console.error(`Error deleting existing ${name} job:`, error);
    }
  }

  const jobId = await context.scheduler?.runJob({ cron, name, data: {} });
  if (jobId) {
    console.debug(`${name} job scheduled with ID: ${jobId}`);
    await context.redis?.set(redisKey, jobId);
  }
}

async function scheduleAllJobs(context: PartialContext) {
  const jobsToSchedule = [
    { name: 'reset_daily_requests', cron: CONSTANTS.CRON_DAILY_MIDNIGHT, redisKey: 'resetDailyRequestsJobId' },
    { name: 'cleanup_queue', cron: CONSTANTS.CRON_HOURLY, redisKey: 'cleanupQueueJobId' },
    { name: 'process_queue', cron: CONSTANTS.CRON_EVERY_30_SECONDS, redisKey: 'processQueueJobId' }
  ];

  for (const job of jobsToSchedule) {
    await scheduleJob(context, job.name, job.cron, job.redisKey);
  }
}

async function handleApiKeyChange(context: PartialContext) {
  const settings = await context.settings?.getAll();
  await tokenBucketInstance.updateLimits(
    settings?.tokens_per_minute as number,
    settings?.requests_per_minute as number,
    settings?.requests_per_day as number,
    context
  );
  
  // Optionally, you could trigger an immediate queue processing here
  // to handle any posts that might have been waiting due to rate limits
  await processQueue(context);
}

Devvit.addTrigger({
  event: 'AppInstall',
  onEvent: async (event, context: PartialContext) => {
    await tokenBucketInstance.checkAndUpdateLimits(context);
    await scheduleAllJobs(context);
    console.info('Jobs scheduled. Automatic summarization will start when conditions are met.');
  },
});

Devvit.addSchedulerJob({
  name: 'process_queue',
  onRun: async (event, context: PartialContext) => {
    const readyToProcess = await isReadyToProcess(context);
    if (readyToProcess) {
      console.info('Running process_queue job...');
      await processQueue(context);
    } else {
      console.info('Skipping process_queue job: not ready to process.');
    }
  },
});

Devvit.addTrigger({
  event: 'AppUpgrade',
  onEvent: async (event, context: PartialContext) => {
    const upgradeInProgress = await context.redis?.get('upgrade_in_progress');
    if (upgradeInProgress) {
      console.log('An upgrade is already in progress. Skipping this trigger.');
      return;
    }
    
    await context.redis?.set('upgrade_in_progress', 'true');
    await context.redis?.expire('upgrade_in_progress', 60);
    
    try {
      const upgradeId = Date.now().toString();
      console.log(`Starting AppUpgrade process: ${upgradeId}`);

      await tokenBucketInstance.checkAndUpdateLimits(context);
      await scheduleAllJobs(context);

      console.log(`Completed AppUpgrade process: ${upgradeId}`);
    } catch (e) {
      console.error('Error during AppUpgrade:', e);
    } finally {
      await context.redis?.del('upgrade_in_progress');
    }
  },
});

const aiSummaryForm = Devvit.createForm(
  {
    fields: [
      {
        name: 'api_key',
        label: 'Gemini API Key',
        type: 'string',
        required: true,
      },
      {
        name: 'temperature',
        label: 'Temperature (0.0 to 1.0)',
        type: 'string',
        defaultValue: CONSTANTS.DEFAULT_TEMPERATURE.toString(),
        required: true,
      },
    ],
    title: 'Create AI Summary',
    acceptLabel: 'Generate Summary',
  },
  async (event, context) => {
    console.log('AI Summary form submitted');
    const apiKey = event.values.api_key.trim();
    const temperature = parseFloat(event.values.temperature);
    
    try {
      if (!apiKey) {
        throw new Error('API Key is required.');
      }

      // Validate the manually provided API key
      const isValidApiKey = await validateApiKey(apiKey);
      if (!isValidApiKey) {
        context.ui.showToast('Invalid API Key. Please check and try again.');
        throw new Error('Invalid API Key. Please check and try again.');
      }

      if (isNaN(temperature) || temperature < 0 || temperature > 1) {
        throw new Error('Temperature must be a number between 0 and 1.');
      }

      const postId = context.postId;
      if (!postId) {
        throw new Error('Unable to identify the post.');
      }

      console.info(`Manual summarization initiated for post ID: ${postId}`);
      const post = await context.reddit.getPostById(postId);
      if (!post) {
        throw new Error('Post not found.');
      }

      const submitToken = await getUniqueToken(context);
      const { title, content, archiveUrl } = await fetchArticleContent(post.url, submitToken, context);
      console.log('Article content fetched');
      
      const includeArchiveLink = await context.settings?.get('include_archive_link') as boolean;
      
      const summary = await summarizeContent(archiveUrl || post.url, title, content, context, apiKey, temperature, includeArchiveLink);
      console.log('Summary generated');
      
      await context.reddit.submitComment({ id: postId, text: summary });
      console.log('Summary comment submitted');
      context.ui.showToast('AI summary created successfully!');
    } catch (error) {
      console.error('Error creating AI summary:', error);
      context.ui.showToast('Failed to create AI summary.');
    }
  }
);

Devvit.addMenuItem({
  label: 'Create an AI Summary',
  location: 'post',
  onPress: async (event, context) => {
    console.log('AI Summary menu item pressed');
    try {
      const settings = await context.settings?.getAll();
      console.log('Settings retrieved:', settings);

      if (settings?.automatic_mode) {
        console.log('Automatic mode is enabled');
        context.ui.showToast('Automatic summarization is enabled. Manual summarization is disabled.');
        return;
      }

      if (!context.postId) {
        console.error('Unable to identify the post');
        context.ui.showToast('Unable to identify the post. Please try again.');
        return;
      }

      const post = await context.reddit.getPostById(context.postId);
      console.log('Post retrieved:', post);

      if (!post || !post.url || post.url === `https://www.reddit.com${post.permalink}`) {
        console.error('Invalid post URL');
        context.ui.showToast('This post does not have a valid URL to summarize.');
        return;
      }

      console.log('Showing AI summary form');
      context.ui.showForm(aiSummaryForm);
    } catch (error) {
      console.error('Error in AI Summary menu item:', error);
      context.ui.showToast('An error occurred while processing your request. Please try again.');
    }
  },
});

Devvit.addTrigger({
  event: 'PostSubmit',
  onEvent: async (event, context: PartialContext) => {
    if (!event.post) return;
    const postId = event.post.id;
    const timestamp = Date.now();
    console.debug(`Enqueuing post ID: ${postId} at ${timestamp}`);
    await context.redis?.zAdd('post_queue', { member: postId, score: timestamp });
  },
});

export default Devvit;
