import { Context } from '@devvit/public-api';
import { fetchArticleContent } from './scrapeUtils.js';
import { summarizeContent } from './summaryUtils.js';
import { CONSTANTS } from '../config/constants.js';
import { tokenBucketInstance, TokenBucket } from './tokenBucket.js';
import { checkAndUpdateApiKey, validateApiKey, invalidateApiKeyValidation } from './apiUtils.js';

type PartialContext = Partial<Context>;

export async function processQueue(context: PartialContext): Promise<void> {
    console.info('Starting to process the post queue.');

    const apiKey = await getApiKey(context);
    if (!apiKey) {
        console.error('API key is missing. Cannot process posts.');
        return;
    }

    const isValid = await validateApiKey(apiKey, context);
    if (!isValid) {
        console.error('Invalid API key. Abandoning queue processing.');
        throw new Error('InvalidApiKey');
    }

    // Check if the daily request limit has been reached
    if (await isDailyLimitReached(context)) {
        console.warn('Daily request limit reached. Skipping queue processing.');
        return;
    }

    // Fetch post IDs from the queue
    const postIds = await fetchPostIds(context);
    if (!postIds || postIds.length === 0) {
        console.info('No posts found in the queue to process.');
        return;
    }

    const settings = await getSettings(context);
    const includeScriptlessLink = settings.includeScriptlessLink;

    // Process up to 10 posts at a time to prevent overwhelming the system
    for (const post of postIds.slice(0, 10)) {
        await processSinglePost(
            post.member,
            context,
            apiKey,
            includeScriptlessLink
        );
    }

    console.info('Finished processing the post queue.');
}

async function isDailyLimitReached(context: PartialContext): Promise<boolean> {
    const requestsToday = parseInt(
        await context.redis?.get(TokenBucket.REQUESTS_TODAY_KEY) || '0'
    );
    return requestsToday >= tokenBucketInstance.requestsPerDay;
}

async function handleApiKeyUpdate(context: PartialContext): Promise<void> {
    const apiKeyChanged = await checkAndUpdateApiKey(context);
    if (apiKeyChanged) {
        console.info('API key changed. Resetting token bucket and clearing authentication error flag.');
        await tokenBucketInstance.resetBucket(context);
        await context.redis?.del('gemini_auth_error');
    }
}

async function getApiKey(context: PartialContext): Promise<string | null> {
    const apiKey = (await context.settings?.get('api_key')) as string;
    if (!apiKey) {
        return null;
    }
    return apiKey;
}

async function fetchPostIds(context: PartialContext): Promise<{ member: string }[] | null> {
    const now = Date.now();
    const postIds = await context.redis?.zRange('post_queue', 0, now, { by: 'score' });
    console.debug(`Fetched post IDs from queue: ${JSON.stringify(postIds)}`);

    if (!postIds) return null;

    return postIds.map(({ member }) => ({ member }));
}

async function getSettings(context: PartialContext): Promise<{ automaticMode: boolean; includeScriptlessLink: boolean }> {
    const automaticMode = (await context.settings?.get('automatic_mode')) as boolean;
    const includeScriptlessLink = (await context.settings?.get('include_scriptless_link')) as boolean;
    return { automaticMode, includeScriptlessLink };
}

async function processSinglePost(
    postId: string,
    context: PartialContext,
    apiKey: string,
    includeScriptlessLink: boolean
): Promise<void> {
    console.info(`Processing post ID: ${postId}`);
    try {
        const post = await context.reddit?.getPostById(postId);
        if (!post) {
            console.warn(`Post ID ${postId} not found.`);
            await context.redis?.zRem('post_queue', [postId]);
            return;
        }

        const url = post.url;
        console.debug(`Fetched URL for post ID ${postId}: ${url}`);

        const currentRetryCount = await getCurrentRetryCount(context, postId);

        let title: string, content: string, scriptlessUrl: string | null;
        try {
            ({ title, content, scriptlessUrl } = await fetchArticleContent(url, context));
        } catch (fetchError) {
            console.error(`Error fetching content for post ${postId}:`, fetchError);
            await retryPost(context, postId, currentRetryCount);
            return;
        }

        await generateAndSubmitSummary(context, postId, scriptlessUrl || url, title, content, apiKey, includeScriptlessLink);
    } catch (error) {
        console.error(`Error processing post ${postId}:`, error);
        await handleGeneralError(context, postId, error);
    }
}

async function getCurrentRetryCount(context: PartialContext, postId: string): Promise<number> {
    const retryCount = await context.redis?.hGet(`retry:${postId}`, 'count') || '0';
    return parseInt(retryCount, 10);
}

async function retryPost(context: PartialContext, postId: string, currentRetryCount: number): Promise<void> {
    if (currentRetryCount < CONSTANTS.MAX_RETRIES) {
        console.warn(`Retrying post ID ${postId} later with delay.`);
        await context.redis?.zAdd('post_queue', { 
            member: postId, 
            score: Date.now() + CONSTANTS.RETRY_INTERVAL + CONSTANTS.RETRY_DELAY 
        });
        await context.redis?.hSet(`retry:${postId}`, { count: (currentRetryCount + 1).toString() });
    } else {
        console.warn(`Max retries reached for post ID ${postId}. Removing from queue.`);
        await context.redis?.zRem('post_queue', [postId]);
        await context.redis?.del(`retry:${postId}`);
    }
}

async function generateAndSubmitSummary(
    context: PartialContext,
    postId: string,
    url: string,
    title: string,
    content: string,
    apiKey: string,
    includeScriptlessLink: boolean
): Promise<void> {
    console.debug(`Generating summary for post ID ${postId}`);
    try {
        const summary = await summarizeContent(url, title, content, context, apiKey, CONSTANTS.DEFAULT_TEMPERATURE, includeScriptlessLink);
        console.debug(`Summary generated for post ID ${postId}`);

        console.info(`Submitting summary comment for post ID ${postId}`);
        const comment = await context.reddit?.submitComment({
            id: postId,
            text: summary,
        });

        if (comment) {
            console.debug(`Making comment sticky for post ID ${postId}`);
            await comment.distinguish(true);
        } else {
            console.warn(`Failed to submit comment for post ID ${postId}`);
        }

        console.debug(`Removing post ID ${postId} from the queue.`);
        await context.redis?.zRem('post_queue', [postId]);
        await context.redis?.del(`retry:${postId}`);
        console.info(`Successfully processed post ID ${postId}`);
    } catch (summaryError) {
        console.error(`Error generating summary for post ${postId}:`, summaryError);
        await handleSummaryError(context, postId, summaryError);
    }
}

async function handleSummaryError(
    context: PartialContext, 
    postId: string, 
    error: any
): Promise<void> {
    if (error?.message === 'GeminiAuthenticationError') {
        console.error('CRITICAL: Gemini API authentication failed. Please check your API key and permissions immediately.');
        await invalidateApiKeyValidation(context);
        await context.redis?.set('gemini_auth_error', 'true');
        throw new Error('GeminiAuthenticationError: Stopping queue processing');
    } else if (isResolvableError(error)) {
        await retryPost(context, postId, await getCurrentRetryCount(context, postId));
    } else if (error?.message === 'DailyRequestLimitReached') {
        console.warn('Daily request limit reached during processing. Stopping further processing.');
    } else {
        console.error(`Non-resolvable error encountered for post ID ${postId}. Removing from queue.`);
        await context.redis?.zRem('post_queue', [postId]);
        await context.redis?.del(`retry:${postId}`);
    }
}

async function handleGeneralError(
    context: PartialContext, 
    postId: string, 
    error: any
): Promise<void> {
    if (isResolvableError(error)) {
        await retryPost(context, postId, await getCurrentRetryCount(context, postId));
    } else {
        console.error(`Non-resolvable error encountered for post ID ${postId}. Removing from queue.`);
        await context.redis?.zRem('post_queue', [postId]);
        await context.redis?.del(`retry:${postId}`);
    }
}

function isResolvableError(error: any): boolean {
    const resolvableErrors = ['TimeoutError', 'ServiceUnavailable', 'RateLimitError'];
    return resolvableErrors.includes(error.name) || 
           (error.message && error.message.toLowerCase().includes('rate limit')) &&
           error.message !== 'GeminiAuthenticationError';
}