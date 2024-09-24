import { Context } from '@devvit/public-api';
import { fetchArticleContent, submitToArchive, getUniqueToken } from './scrapeUtils.js';
import { summarizeContent } from './summaryUtils.js';
import { CONSTANTS } from '../config/constants.js';
import { tokenBucketInstance, TokenBucket } from './tokenBucket.js';
import { checkAndUpdateApiKey } from './apiUtils.js';

type PartialContext = Partial<Context>;

export async function processQueue(context: PartialContext): Promise<void> {
    console.info('Starting to process the queue...');

    if (await isDailyLimitReached(context)) {
        console.warn('Daily request limit reached. Pausing queue processing.');
        return;
    }

    await handleApiKeyUpdate(context);

    const apiKey = await getApiKey(context);
    if (!apiKey) {
        console.error('API key is not set. Pausing queue processing.');
        return;
    }

    const postIds = await fetchPostIds(context);
    if (!postIds || postIds.length === 0) {
        console.warn('No posts found in the queue to process.');
        return;
    }

    let token;
    try {
        token = await getUniqueToken(context);
    } catch (error) {
        console.error('Failed to obtain archive.is token:', error);
        return;
    }

    const settings = await getSettings(context);
    const automaticMode = settings.automaticMode;
    const includeArchiveLink = settings.includeArchiveLink;

    for (const postId of postIds.slice(0, 10)) {
        await processSinglePost(postId.member, context, token, apiKey, automaticMode, includeArchiveLink);
    }
}

async function isDailyLimitReached(context: PartialContext): Promise<boolean> {
    const requestsToday = parseInt(await context.redis?.get(TokenBucket.REQUESTS_TODAY_KEY) || '0');
    return requestsToday >= tokenBucketInstance.requestsPerDay;
}

async function handleApiKeyUpdate(context: PartialContext): Promise<void> {
    const apiKeyChanged = await checkAndUpdateApiKey(context);
    if (apiKeyChanged) {
        console.info('API key changed. Resetting token bucket.');
        await tokenBucketInstance.resetBucket(context);
    }
}

async function getApiKey(context: PartialContext): Promise<string | null> {
    const apiKey = await context.settings?.get('api_key') as string;
    if (!apiKey) {
        return null;
    }
    return apiKey;
}

async function fetchPostIds(context: PartialContext): Promise<{ member: string }[] | null> {
    const now = Date.now();
    const postIds = await context.redis?.zRange('post_queue', 0, now, { by: 'score' });
    console.debug(`Fetched post IDs from queue: ${postIds}`);
    
    if (!postIds) return null;
    
    return postIds.map(({ member }) => ({ member }));
}

async function getSettings(context: PartialContext): Promise<{ automaticMode: boolean; includeArchiveLink: boolean }> {
    const automaticMode = await context.settings?.get('automatic_mode') as boolean;
    const includeArchiveLink = await context.settings?.get('include_archive_link') as boolean;
    return { automaticMode, includeArchiveLink };
}

async function processSinglePost(
    postId: string,
    context: PartialContext,
    token: string,
    apiKey: string,
    automaticMode: boolean,
    includeArchiveLink: boolean
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

        let title, content, isArchived, archiveUrl;
        try {
            ({ title, content, isArchived, archiveUrl } = await fetchArticleContent(url, token, context));
        } catch (fetchError) {
            console.error(`Error fetching content for post ${postId}:`, fetchError);
            await retryPost(context, postId, currentRetryCount);
            return;
        }

        if (!isArchived) {
            await handleArchiving(context, postId, url, token, currentRetryCount);
            return;
        }

        await generateAndSubmitSummary(context, postId, archiveUrl || url, title, content, apiKey, includeArchiveLink);
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

async function handleArchiving(
    context: PartialContext,
    postId: string,
    url: string,
    token: string,
    currentRetryCount: number
): Promise<void> {
    try {
        await submitToArchive(url, token);
    } catch (archiveError) {
        console.error(`Error submitting to archive for post ID ${postId}:`, archiveError);
        await retryPost(context, postId, currentRetryCount);
        return;
    }

    if (currentRetryCount >= CONSTANTS.MAX_RETRIES) {
        console.warn(`Max retries reached for post ID ${postId}. Removing from queue.`);
        await context.redis?.zRem('post_queue', [postId]);
        await context.redis?.del(`retry:${postId}`);
    } else {
        console.debug(`Content not yet archived for post ID ${postId}. Will retry later.`);
        await context.redis?.zAdd('post_queue', { member: postId, score: Date.now() + CONSTANTS.RETRY_INTERVAL });
        await context.redis?.hSet(`retry:${postId}`, { count: (currentRetryCount + 1).toString() });
    }
}

async function generateAndSubmitSummary(
    context: PartialContext,
    postId: string,
    url: string,
    title: string,
    content: string,
    apiKey: string,
    includeArchiveLink: boolean
): Promise<void> {
    console.debug(`Generating summary for post ID ${postId}`);
    try {
        const summary = await summarizeContent(url, title, content, context, apiKey, CONSTANTS.DEFAULT_TEMPERATURE, includeArchiveLink);
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
    if (isResolvableError(error)) {
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
    return resolvableErrors.includes(error.name) || (error.message && error.message.toLowerCase().includes('rate limit'));
}