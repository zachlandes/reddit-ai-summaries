import { Devvit, SettingScope, Context } from '@devvit/public-api';
import { tokenBucket } from './utils/tokenBucket.js';
import { summarizeContent } from './utils/summaryUtils.js';
import { DEFAULT_GEMINI_LIMITS } from './config/geminiLimits.js';
import { processQueue, cleanupQueue } from './utils/queueProcessor.js';

// Define a type for partial context
type PartialContext = Partial<Context>;

Devvit.configure({
  redis: true,
  redditAPI: true,
});

Devvit.addSettings([
  {
    type: 'string',
    name: 'api_key',
    label: 'Enter your Gemini API Key:',
    onValidate: async ({ value }) => {
      if (!value || value.trim() === '') {
        return 'API Key cannot be empty';
      }
    },
  },
  {
    type: 'number',
    name: 'requests_per_minute',
    label: 'Set Requests per Minute:',
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
    label: 'Set Tokens per Minute:',
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
    label: 'Set Requests per Day:',
    defaultValue: DEFAULT_GEMINI_LIMITS.REQUESTS_PER_DAY,
    onValidate: async ({ value }) => {
      if (typeof value !== 'number' || value < 1) {
        return 'Requests per day must be a number at least 1';
      }
    },
  },
]);

Devvit.addSchedulerJob({
  name: 'reset_daily_requests',
  onRun: async (event, context: PartialContext) => {
    console.info('Running reset_daily_requests job...');
    await tokenBucket.resetDailyRequests(context);
  },
});

// Add new scheduler jobs for queue processing and cleanup
Devvit.addSchedulerJob({
  name: 'process_queue',
  onRun: async (event, context: PartialContext) => {
    console.info('Running process_queue job...');
    await processQueue(context);
  },
});

Devvit.addSchedulerJob({
  name: 'cleanup_queue',
  onRun: async (event, context: PartialContext) => {
    console.info('Running cleanup_queue job...');
    await cleanupQueue(context);
  },
});

// Initialize or update the token bucket with current settings
Devvit.addTrigger({
  event: 'AppInstall',
  onEvent: async (event, context: PartialContext) => {
    const settings = await context.settings?.getAll();
    tokenBucket.updateLimits(
      settings?.tokensPerMinute as number,
      settings?.requestsPerMinute as number,
      settings?.requestsPerDay as number
    );

    // Schedule the scheduler jobs
    try {
      console.info('Scheduling reset_daily_requests job...');
      const resetJobId = await context.scheduler?.runJob({
        cron: '0 0 * * *', // Run daily at midnight
        name: 'reset_daily_requests',
        data: {},
      });
      if (resetJobId) {
        console.debug(`reset_daily_requests job scheduled with ID: ${resetJobId}`);
        await context.redis?.set('resetDailyRequestsJobId', resetJobId);
      }

      console.info('Scheduling process_queue job...');
      const processQueueJobId = await context.scheduler?.runJob({
        cron: '*/30 * * * * *', // Run every 30 seconds
        name: 'process_queue',
        data: {},
      });
      if (processQueueJobId) {
        console.debug(`process_queue job scheduled with ID: ${processQueueJobId}`);
        await context.redis?.set('processQueueJobId', processQueueJobId);
      }

      console.info('Scheduling cleanup_queue job...');
      const cleanupQueueJobId = await context.scheduler?.runJob({
        cron: '0 * * * *', // Run hourly
        name: 'cleanup_queue',
        data: {},
      });
      if (cleanupQueueJobId) {
        console.debug(`cleanup_queue job scheduled with ID: ${cleanupQueueJobId}`);
        await context.redis?.set('cleanupQueueJobId', cleanupQueueJobId);
      }
    } catch (e) {
      console.error('Error scheduling jobs:', e);
      throw e;
    }
  },
});

// Add trigger for new posts to enqueue them
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
