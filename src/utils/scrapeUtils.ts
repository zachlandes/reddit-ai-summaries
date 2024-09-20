import { JSDOM} from 'jsdom';
import { Readability } from '@mozilla/readability';
import { Devvit } from '@devvit/public-api';

Devvit.configure({
    http: true,
})

export async function fetchArticleContent(url: string): Promise<{ title: string; content: string }> {
    // Fetch the HTML content
    const response = await fetch(url, {
        method: 'GET',
        headers: {
            'User-Agent': 'Devvit AI Summaries App (https://developers.reddit.com/)', //TODO: Update this link with app's directory page
            'Accept': 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
        }
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch page, status code: ${response.status}`);
    }
  
    const html = await response.text();
  
    // Parse the HTML using JSDOM
    const dom = new JSDOM(html, { url }); // The `url` option is important for relative links
  
    // Use Readability to extract the article
    const reader = new Readability(dom.window.document);
    const article = reader.parse();
  
    if (!article) {
      throw new Error('Could not extract article content');
    }
  
    return {
      title: article.title,
      content: article.textContent,
    };
  }
