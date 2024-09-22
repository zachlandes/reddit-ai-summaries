import { Devvit, SettingScope, Context, SettingsFormFieldValidatorEvent } from '@devvit/public-api';
import { tokenBucket } from './utils/tokenBucket.js';
import { summarizeContent } from './utils/summaryUtils.js';
import { DEFAULT_GEMINI_LIMITS } from './config/geminiLimits.js';
import { processQueue, cleanupQueue } from './utils/queueProcessor.js';
import { fetchArticleContent, getUniqueToken } from './utils/scrapeUtils.js';

// Define a type for partial context
type PartialContext = Partial<Context>;

Devvit.configure({
  redis: true,
  redditAPI: true,
});

Devvit.addSettings([
  {
    type: 'boolean',
    name: 'automatic_mode',
    label: 'Enable Automatic Summarization:',
    defaultValue: true,
    onValidate: async (event: SettingsFormFieldValidatorEvent<boolean>, context: Devvit.Context) => {
      if (event.value) {
        return 'Automatic summarization is enabled. Manual summarization is disabled.';
      }
    },
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
      return undefined;
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
      settings?.tokens_per_minute as number,
      settings?.requests_per_minute as number,
      settings?.requests_per_day as number
    );

    if (settings?.automatic_mode) {
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
    } else {
      console.info('Automatic summarization is disabled.');
    }
  },
});

// Handle AppUpdate similarly
Devvit.addTrigger({
  event: 'AppUpgrade',
  onEvent: async (event, context: PartialContext) => {
    const settings = await context.settings?.getAll();
    tokenBucket.updateLimits(
      settings?.tokens_per_minute as number,
      settings?.requests_per_minute as number,
      settings?.requests_per_day as number
    );

    // Remove existing jobs
    try {
      const resetJobId = await context.redis?.get('resetDailyRequestsJobId');
      const processQueueJobId = await context.redis?.get('processQueueJobId');
      const cleanupQueueJobId = await context.redis?.get('cleanupQueueJobId');

      if (resetJobId) {
        await context.scheduler?.cancelJob(resetJobId);
        console.debug(`Removed reset_daily_requests job with ID: ${resetJobId}`);
      }
      if (processQueueJobId) {
        await context.scheduler?.cancelJob(processQueueJobId);
        console.debug(`Removed process_queue job with ID: ${processQueueJobId}`);
      }
      if (cleanupQueueJobId) {
        await context.scheduler?.cancelJob(cleanupQueueJobId);
        console.debug(`Removed cleanup_queue job with ID: ${cleanupQueueJobId}`);
      }

      // Reschedule if automatic_mode is enabled
      if (settings?.automatic_mode) {
        console.info('Rescheduling jobs due to AppUpdate...');
        const newResetJobId = await context.scheduler?.runJob({
          cron: '0 0 * * *',
          name: 'reset_daily_requests',
          data: {},
        });
        if (newResetJobId) {
          console.debug(`reset_daily_requests job rescheduled with ID: ${newResetJobId}`);
          await context.redis?.set('resetDailyRequestsJobId', newResetJobId);
        }

        const newProcessQueueJobId = await context.scheduler?.runJob({
          cron: '*/30 * * * * *',
          name: 'process_queue',
          data: {},
        });
        if (newProcessQueueJobId) {
          console.debug(`process_queue job rescheduled with ID: ${newProcessQueueJobId}`);
          await context.redis?.set('processQueueJobId', newProcessQueueJobId);
        }

        const newCleanupQueueJobId = await context.scheduler?.runJob({
          cron: '0 * * * *',
          name: 'cleanup_queue',
          data: {},
        });
        if (newCleanupQueueJobId) {
          console.debug(`cleanup_queue job rescheduled with ID: ${newCleanupQueueJobId}`);
          await context.redis?.set('cleanupQueueJobId', newCleanupQueueJobId);
        }
      }
    } catch (e) {
      console.error('Error rescheduling jobs:', e);
      throw e;
    }
  },
});

// Define the form outside of the menu item
const aiSummaryForm = Devvit.createForm(
  {
    fields: [
      {
        name: 'api_key',
        label: 'Gemini API Key',
        type: 'string',
        required: true,
      },
    ],
    title: 'Create AI Summary',
    acceptLabel: 'Generate Summary',
  },
  async (event, context) => {
    console.log('AI Summary form submitted');
    const apiKey = event.values.api_key.trim();
    if (!apiKey) {
      console.error('API Key is empty');
      context.ui.showToast('API Key is required.');
      return;
    }

    const postId = context.postId;
    try {
      console.info(`Manual summarization initiated for post ID: ${postId}`);
      const post = await context.reddit.getPostById(postId as string);
      if (!post) {
        console.error('Post not found');
        context.ui.showToast('Post not found.');
        return;
      }

      // Get a unique token for archive.is
      const submitToken = await getUniqueToken();

      const { title, content } = await fetchArticleContent(post.url, submitToken);
      console.log('Article content fetched');
      const summary = await summarizeContent(title, content, context, apiKey);
      console.log('Summary generated');
      
      await context.reddit.submitComment({ id: postId!, text: summary });
      console.log('Summary comment submitted');
      context.ui.showToast('AI summary created successfully!');
    } catch (error) {
      console.error('Error creating AI summary:', error);
      context.ui.showToast('Failed to create AI summary.');
    }
  }
);

// Update the menu item to use the created form
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

const myForm = Devvit.createForm(
  {
    fields: [
      {
        type: 'string',
        name: 'food',
        label: 'What is your favorite food?',
      },
    ],
  },
  (event, context) => {
    // onSubmit handler
    context.ui.showToast({ text: event.values.food ?? 'No food selected' });
  }
);

Devvit.addMenuItem({
  label: 'Show a form',
  location: 'post',
  onPress: async (_event, context) => {
    context.ui.showForm(myForm);
  },
});

export default Devvit;
