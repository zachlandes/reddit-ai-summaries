import { Context } from '@devvit/public-api';
import { fetchArticleContent } from './scrapeUtils.js';
import { summarizeContent } from './summaryUtils.js';

// Define PartialContext type
type PartialContext = Partial<Context>;

export async function processQueue(context: PartialContext): Promise<void> {
  const now = Date.now();

  // Fetch up to 10 posts to process
  const postIds = await context.redis?.zRange('post_queue', 0, 9, { by: 'score' });

  if (!postIds) return;

  for (const postId of postIds) {
    try {
      // Fetch post details
      const post = await context.reddit?.getPostById(postId.member);
      if (!post) continue;
      const url = post.url;

      // Scrape content
      const { title, content } = await fetchArticleContent(url);

      // Generate summary
      const summary = await summarizeContent(title, content, context);

      // Post summary as a sticky comment
      await context.reddit?.submitComment({ id: postId.member, text: summary });

      // Remove from queue
      await context.redis?.zRem('post_queue', [postId.member]);
    } catch (error) {
      console.error(`Error processing post ${postId.member}:`, error);

      if (isResolvableError(error)) {
        // Do not remove from queue to retry later
        continue;
      } else {
        // Remove from queue despite the error
        await context.redis?.zRem('post_queue', [postId.member]);
      }
    }
  }
}

export async function cleanupQueue(context: PartialContext): Promise<void> {
  const oneDayAgoSeconds = Math.floor(Date.now() / 1000) - 86400; // 24 hours in seconds
  await context.redis?.zRemRangeByScore('post_queue', 0, oneDayAgoSeconds);
}

export async function addToQueue(context: PartialContext, postId: string): Promise<void> {
  const now = Date.now();
  await context.redis?.zAdd('post_queue', { member: postId, score: now });
}

function isResolvableError(error: any): boolean {
  // Define logic to determine if the error is resolvable
  const resolvableErrors = ['TimeoutError', 'ServiceUnavailable'];
  return resolvableErrors.includes(error.name);
}