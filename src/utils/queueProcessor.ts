import { Context } from '@devvit/public-api';
import { fetchArticleContent } from './scrapeUtils.js';
import { summarizeContent } from './summaryUtils.js';

// Define PartialContext type
type PartialContext = Partial<Context>;

export async function processQueue(context: PartialContext): Promise<void> {
  console.info('Starting to process the queue...');
  const now = Date.now();

  // Fetch up to 10 post IDs to process based on rank (0-9)
  const postIds = await context.redis?.zRange('post_queue', 0, 9);

  console.debug(`Fetched post IDs from queue: ${postIds}`);

  if (!postIds || postIds.length === 0) {
    console.warn('No posts found in the queue to process.');
    return;
  }

  for (const postId of postIds) {
    console.info(`Processing post ID: ${postId.member}`);
    try {
      // Fetch post details
      const post = await context.reddit?.getPostById(postId.member);
      if (!post) {
        console.warn(`Post ID ${postId.member} not found.`);
        continue;
      }
      const url = post.url;
      console.debug(`Fetched URL for post ID ${postId.member}: ${url}`);

      // Scrape content
      console.debug(`Fetching article content from URL: ${url}`);
      const { title, content } = await fetchArticleContent(url);
      console.debug(`Fetched content for post ID ${postId.member}`);

      // Generate summary
      console.debug(`Generating summary for post ID ${postId.member}`);
      const summary = await summarizeContent(title, content, context);
      console.debug(`Summary generated for post ID ${postId.member}`);

      // Post summary as a comment and then make it sticky
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

      // Remove from queue
      console.debug(`Removing post ID ${postId.member} from the queue.`);
      await context.redis?.zRem('post_queue', [postId.member]);
      console.info(`Successfully processed post ID ${postId.member}`);
    } catch (error) {
      console.error(`Error processing post ${postId.member}:`, error);

      if (isResolvableError(error)) {
        console.warn(`Resolvable error encountered for post ID ${postId.member}. Will retry later.`);
        // Do not remove from queue to retry later
        continue;
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
  const oneDayAgoSeconds = Math.floor(Date.now() / 1000) - 86400; // 24 hours in seconds
  console.debug(`Removing posts with scores between 0 and ${oneDayAgoSeconds}`);
  const removed = await context.redis?.zRemRangeByScore('post_queue', 0, oneDayAgoSeconds);
  console.info(`Cleanup completed. Removed ${removed} old posts from the queue.`);
}

function isResolvableError(error: any): boolean {
  // Define logic to determine if the error is resolvable
  const resolvableErrors = ['TimeoutError', 'ServiceUnavailable'];
  return resolvableErrors.includes(error.name);
}