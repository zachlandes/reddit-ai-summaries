import { Context } from '@devvit/public-api';
import { fetchArticleContent, submitToArchive, getUniqueToken } from './scrapeUtils.js';
import { summarizeContent } from './summaryUtils.js';
import { CONSTANTS } from '../config/constants.js';
import { tokenBucketInstance } from './tokenBucket.js';
import { checkAndUpdateApiKey } from './apiUtils.js';

type PartialContext = Partial<Context>;

export async function processQueue(context: PartialContext): Promise<void> {
    console.info('Starting to process the queue...');
    
    const now = Date.now();

    const apiKeyChanged = await checkAndUpdateApiKey(context);
    if (apiKeyChanged) {
        console.info('API key changed. Resetting token bucket.');
        await tokenBucketInstance.resetBucket(context);
    }

    const apiKey = await context.settings?.get('api_key') as string;
    if (!apiKey) {
        console.error('API key is not set. Pausing queue processing.');
        return;
    }

    const postIds = await context.redis?.zRange('post_queue', 0, now, { by: 'score' });

    console.debug(`Fetched post IDs from queue: ${postIds}`);

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

    const includeArchiveLink = await context.settings?.get('include_archive_link') as boolean;

    for (const postId of postIds.slice(0, 10)) {
        console.info(`Processing post ID: ${postId.member}`);
        try {
            const post = await context.reddit?.getPostById(postId.member);
            if (!post) {
                console.warn(`Post ID ${postId.member} not found.`);
                await context.redis?.zRem('post_queue', [postId.member]);
                continue;
            }
            const url = post.url;
            console.debug(`Fetched URL for post ID ${postId.member}: ${url}`);

            const retryCount = await context.redis?.hGet(`retry:${postId.member}`, 'count') || '0';
            const currentRetryCount = parseInt(retryCount, 10);

            console.debug(`Fetching article content from URL: ${url}`);
            let { title, content, isArchived, archiveUrl } = await fetchArticleContent(url, token, context);

            if (!isArchived) {
                await submitToArchive(url, token);
                if (currentRetryCount >= CONSTANTS.MAX_RETRIES) {
                    console.warn(`Max retries reached for post ID ${postId.member}. Removing from queue.`);
                    await context.redis?.zRem('post_queue', [postId.member]);
                    await context.redis?.del(`retry:${postId.member}`);
                } else {
                    console.debug(`Content not yet archived for post ID ${postId.member}. Will retry later.`);
                    await context.redis?.zAdd('post_queue', { member: postId.member, score: now + CONSTANTS.RETRY_INTERVAL });
                    await context.redis?.hSet(`retry:${postId.member}`, { count: (currentRetryCount + 1).toString() });
                }
                continue;
            }

            console.debug(`Fetched content for post ID ${postId.member}`);

            console.debug(`Generating summary for post ID ${postId.member}`);
            try {
                const summary = await summarizeContent(
                    archiveUrl || post.url,
                    title,
                    content,
                    context,
                    apiKey,
                    CONSTANTS.DEFAULT_TEMPERATURE,
                    includeArchiveLink
                );
                console.debug(`Summary generated for post ID ${postId.member}`);

                console.info(`Submitting summary comment for post ID ${postId.member}`);
                const comment = await context.reddit?.submitComment({
                    id: postId.member,
                    text: summary,
                });

                if (comment) {
                    console.debug(`Making comment sticky for post ID ${postId.member}`);
                    await comment.distinguish(true);
                } else {
                    console.warn(`Failed to submit comment for post ID ${postId.member}`);
                }

                console.debug(`Removing post ID ${postId.member} from the queue.`);
                await context.redis?.zRem('post_queue', [postId.member]);
                await context.redis?.del(`retry:${postId.member}`);
                console.info(`Successfully processed post ID ${postId.member}`);
            } catch (summaryError) {
                console.error(`Error generating summary for post ${postId.member}:`, summaryError);
                await handleSummaryError(context, postId.member, summaryError, currentRetryCount, now);
            }
        } catch (error) {
            console.error(`Error processing post ${postId.member}:`, error);
            await handleProcessingError(context, postId.member, error, now);
        }
    }
}

async function handleSummaryError(
    context: PartialContext, 
    postId: string, 
    error: any, 
    currentRetryCount: number, 
    now: number
): Promise<void> {
    if (isResolvableError(error)) {
        if (currentRetryCount < CONSTANTS.MAX_RETRIES) {
            console.warn(`Resolvable error encountered for post ID ${postId}. Will retry later.`);
            await context.redis?.zAdd('post_queue', { member: postId, score: now + CONSTANTS.RETRY_INTERVAL });
            await context.redis?.hSet(`retry:${postId}`, { count: (currentRetryCount + 1).toString() });
        } else {
            console.warn(`Max retries reached for post ID ${postId}. Removing from queue.`);
            await context.redis?.zRem('post_queue', [postId]);
            await context.redis?.del(`retry:${postId}`);
        }
    } else {
        console.error(`Non-resolvable error encountered for post ID ${postId}. Removing from queue.`);
        await context.redis?.zRem('post_queue', [postId]);
        await context.redis?.del(`retry:${postId}`);
    }
}

async function handleProcessingError(
    context: PartialContext, 
    postId: string, 
    error: any, 
    now: number
): Promise<void> {
    if (isResolvableError(error)) {
        console.warn(`Resolvable error encountered for post ID ${postId}. Will retry later.`);
        await context.redis?.zAdd('post_queue', { member: postId, score: now + CONSTANTS.RETRY_INTERVAL });
    } else {
        console.error(`Non-resolvable error encountered for post ID ${postId}. Removing from queue.`);
        await context.redis?.zRem('post_queue', [postId]);
    }
}

function isResolvableError(error: any): boolean {
    const resolvableErrors = ['TimeoutError', 'ServiceUnavailable', 'RateLimitError'];
    return resolvableErrors.includes(error.name) || error.message.includes('rate limit');
}

export async function cleanupQueue(context: PartialContext): Promise<void> {
    console.info('Starting cleanup of the queue...');
    const now = Date.now();
    const oneDayAgo = now - 86400000; // 24 hours in milliseconds

    const allItems = await context.redis?.zRange('post_queue', 0, -1, { by: 'score' });

    if (allItems && allItems.length > 0) {
        const itemsToRemove = allItems
            .filter(item => item.score < oneDayAgo)
            .map(item => item.member);

        if (itemsToRemove.length > 0) {
            const removed = await context.redis?.zRem('post_queue', itemsToRemove);
            console.info(`Cleanup completed. Removed ${removed} old posts from the queue.`);
        } else {
            console.info('No old posts to remove from the queue.');
        }
    } else {
        console.info('Queue is empty. No cleanup needed.');
    }
}