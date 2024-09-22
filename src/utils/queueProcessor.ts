import { Context } from '@devvit/public-api';
import { fetchArticleContent, submitToArchive } from './scrapeUtils.js';
import { summarizeContent } from './summaryUtils.js';

// Define PartialContext type
type PartialContext = Partial<Context>;

const MAX_RETRIES = 2; // Maximum number of retries before removing from queue
const RETRY_INTERVAL = 300000; // 5 minutes in milliseconds
const TOKEN_VALIDITY_DURATION = 60 * 60 * 1000; // 1 hour in milliseconds

let cachedToken: string | null = null;
let tokenExpirationTime: number = 0;

async function getUniqueToken(context: PartialContext): Promise<string> {
	const now = Date.now();
	if (cachedToken && now < tokenExpirationTime) {
		return cachedToken;
	}

	// Fetch new token from Redis or archive.is
	const storedToken = await context.redis?.get('archive_token');
	const storedExpiration = await context.redis?.get('archive_token_expiration');

	if (storedToken && storedExpiration && now < parseInt(storedExpiration)) {
		cachedToken = storedToken;
		tokenExpirationTime = parseInt(storedExpiration);
		return cachedToken;
	}

	// If no valid token in Redis, fetch from archive.is
	const response = await fetch("http://archive.is/");
	const html = await response.text();
	
	const submitidMatch = html.match(/name="submitid"\s+value="([^"]+)"/);
	if (submitidMatch && submitidMatch[1]) {
		cachedToken = submitidMatch[1];
		tokenExpirationTime = now + TOKEN_VALIDITY_DURATION;
		
		// Store in Redis
		await context.redis?.set('archive_token', cachedToken);
		await context.redis?.set('archive_token_expiration', tokenExpirationTime.toString());
		
		return cachedToken;
	}
	throw new Error("Failed to obtain unique token");
}

export async function processQueue(context: PartialContext): Promise<void> {
	console.info('Starting to process the queue...');
	const now = Date.now();

	// Fetch up to 10 post IDs to process, sorted by score (timestamp)
	const postIds = await context.redis?.zRange('post_queue', 0, now, { by: 'score' });

	console.debug(`Fetched post IDs from queue: ${postIds}`);

	if (!postIds || postIds.length === 0) {
		console.warn('No posts found in the queue to process.');
		return;
	}

	// Get or refresh the token before processing
	try {
		await getUniqueToken(context);
	} catch (error) {
		console.error('Failed to obtain archive.is token:', error);
		return;
	}

	// Process only the first 10 items
	for (const postId of postIds.slice(0, 10)) {
		console.info(`Processing post ID: ${postId.member}`);
		try {
			// Fetch post details
			const post = await context.reddit?.getPostById(postId.member);
			if (!post) {
				console.warn(`Post ID ${postId.member} not found.`);
				await context.redis?.zRem('post_queue', [postId.member]);
				continue;
			}
			const url = post.url;
			console.debug(`Fetched URL for post ID ${postId.member}: ${url}`);

			// Get the current retry count
			const retryCount = await context.redis?.hGet(`retry:${postId.member}`, 'count') || '0';
			const currentRetryCount = parseInt(retryCount, 10);

			// Scrape content
			console.debug(`Fetching article content from URL: ${url}`);
			let { title, content, isArchived, archiveUrl } = await fetchArticleContent(url, cachedToken!);

			if (!isArchived) {
				await submitToArchive(url, cachedToken!);
				if (currentRetryCount >= MAX_RETRIES) {
					console.warn(`Max retries reached for post ID ${postId.member}. Removing from queue.`);
					await context.redis?.zRem('post_queue', [postId.member]);
					await context.redis?.del(`retry:${postId.member}`);
				} else {
					console.debug(`Content not yet archived for post ID ${postId.member}. Will retry later.`);
					// Update the score to retry after 5 minutes
					await context.redis?.zAdd('post_queue', { member: postId.member, score: now + RETRY_INTERVAL });
					// Increment retry count
					await context.redis?.hSet(`retry:${postId.member}`, { count: (currentRetryCount + 1).toString() });
				}
				continue;
			}

			console.debug(`Fetched content for post ID ${postId.member}`);

			// Generate summary
			console.debug(`Generating summary for post ID ${postId.member}`);
			const summary = await summarizeContent(title, content, context);
			console.debug(`Summary generated for post ID ${postId.member}`);

			// Add archive link to the summary
			const summaryWithArchiveLink = `${summary}\n\nArchived version: ${archiveUrl}`;

			// Post summary as a comment and then make it sticky
			console.info(`Submitting summary comment for post ID ${postId.member}`);
			const comment = await context.reddit?.submitComment({
				id: postId.member,
				text: summaryWithArchiveLink,
			});

			if (comment) {
				console.debug(`Making comment sticky for post ID ${postId.member}`);
				await comment.distinguish(true);
			} else {
				console.warn(`Failed to submit comment for post ID ${postId.member}`);
			}

			// Remove from queue and clear retry count
			console.debug(`Removing post ID ${postId.member} from the queue.`);
			await context.redis?.zRem('post_queue', [postId.member]);
			await context.redis?.del(`retry:${postId.member}`);
			console.info(`Successfully processed post ID ${postId.member}`);
		} catch (error) {
			console.error(`Error processing post ${postId.member}:`, error);

			if (isResolvableError(error)) {
				console.warn(`Resolvable error encountered for post ID ${postId.member}. Will retry later.`);
				// Update the score to retry after 5 minutes
				await context.redis?.zAdd('post_queue', { member: postId.member, score: now + RETRY_INTERVAL });
			} else {
				console.error(`Non-resolvable error encountered for post ID ${postId.member}. Removing from queue.`);
				// Remove from queue despite the error
				await context.redis?.zRem('post_queue', [postId.member]);
			}
		}
	}
}

export async function cleanupQueue(context: PartialContext): Promise<void> {
	console.info('Starting cleanup of the queue...');
	const now = Date.now();
	const oneDayAgo = now - 86400000; // 24 hours in milliseconds

	// Fetch all items in the queue
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

function isResolvableError(error: any): boolean {
	// Define logic to determine if the error is resolvable
	const resolvableErrors = ['TimeoutError', 'ServiceUnavailable'];
	return resolvableErrors.includes(error.name);
}