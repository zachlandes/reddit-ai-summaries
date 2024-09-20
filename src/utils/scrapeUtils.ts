import * as cheerio from 'cheerio';
import { Devvit } from '@devvit/public-api';

Devvit.configure({
    http: true,
})

export async function fetchArticleContent(url: string): Promise<{ title: string; content: string }> {
    console.info(`Fetching article content from URL: ${url}`);
    // Fetch the HTML content
    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'User-Agent': 'Devvit AI Summaries App (https://developers.reddit.com/)', //TODO: Update this link with app's directory page
                'Accept': 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
            }
        });
        console.debug(`Received response with status: ${response.status}`);
        if (!response.ok) {
          console.error(`Failed to fetch page, status code: ${response.status}`);
          throw new Error(`Failed to fetch page, status code: ${response.status}`);
        }
      
        const html = await response.text();
        console.debug('Fetched HTML content successfully.');
      
        // Load HTML into Cheerio
        const $ = cheerio.load(html);
        console.debug('Loaded HTML into Cheerio.');
      
        // Extract title
        const title = $('title').text() || 'No title found';
        console.debug(`Extracted title: ${title}`);
    
        // Extract main content
        let content = '';
        if ($('article').length) {
            content = $('article').text();
            console.debug('Extracted content from <article> tag.');
        } else {
            // Fallback: Extract text from the body
            content = $('body').text();
            console.debug('Extracted content from <body> tag as fallback.');
        }
    
        // Clean up the content
        content = content.replace(/\s+/g, ' ').trim();
        console.debug('Cleaned up the extracted content.');
    
        return {
          title,
          content,
        };
    } catch (error) {
        console.error(`Error fetching article content from URL ${url}:`, error);
        throw error;
    }
}
