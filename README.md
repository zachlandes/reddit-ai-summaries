# AI Summaries for Reddit

Enhance your subreddit with AI-powered summaries of linked content, automatically or on-demand, and completely free!

## Overview

AI Summaries is a powerful tool that generates concise, unbiased summaries of linked content in your subreddit posts. Whether you want to provide quick insights for your community to promote better discussions or save time reviewing content, this app has you covered.

Key features:
- Automatic summarization of new posts
- Manual summarization option for specific posts
- Summaries posted as stickied comments for easy visibility
- Includes an 12ft.io link to ensure the article is accessible without scripts (optional)
- Multilingual support: summarizes content in its original language and provides an English translation
- Uses Google's advanced Gemini AI for high-quality summaries
- Designed to work within the free tier limits of the Gemini API (up to 1500 summaries per day)

## How It Works

1. When a new post with a link is submitted to your subreddit, the app can automatically generate a summary (if enabled).
2. Moderators can also manually trigger summaries for specific posts.
3. The app fetches the content from the linked URL via 12ft.io.
4. Using Google's Gemini AI, it generates a concise, informative summary.
5. The summary, and optional script-free 12ft.io link, is posted as a stickied comment on the original post, making it easily visible to all users.

## Setup

1. Install the AI Summaries app from the [Reddit App Directory](https://developers.reddit.com/apps/ai-summaries) (click "Add to Community" at the top)
2. Obtain a Google AI API key (free and no credit card required!):
   - Visit [Google AI Studio](https://ai.google.dev/)
   - Sign up or log in to your Google account
   - Navigate to the API section and create a new API key
   - Copy your API key for use in the next step
3. In your subreddit's app settings, paste your Google AI API key.
4. Configure other settings as desired. The default rate limits are configured to work within the free tier of the Gemini API.

## Usage

### Automatic Mode
Once set up, the app will automatically summarize new posts containing links (if enabled in settings).

### Manual Summarization
1. As a user, navigate to any post in your subreddit.
2. Look for the "Create an AI Summary" option in the post's menu.
3. Click it, enter your gemini API key, and click "Create Summary" to generate and post a summary.

## Customization

You can adjust several settings to tailor the app to your subreddit's needs:
- Enable/disable automatic summarization
- Set maximum requests per minute and per day (we recommend you change this only if you have a paid Google AI account)
- Adjust the AI's "temperature" setting to control creativity vs. consistency in summaries
- Choose whether to include the archive link in the summary comment

## Support

If you encounter any issues or have questions, please reach out to us through the Reddit App Directory support channels or dm me on reddit, [u/thezachlandes](https://www.reddit.com/user/thezachlandes).

## GitHub Repository

The code for AI Summaries is open source and available on GitHub: [zachlandes/reddit-ai-summaries](https://github.com/zachlandes/reddit-ai-summaries).

---

Enhance your subreddit's content and save time with AI Summaries – your intelligent content assistant!