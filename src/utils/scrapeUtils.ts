import * as cheerio from 'cheerio';
import { Context } from '@devvit/public-api';
import { CONSTANTS } from '../config/constants.js';
import { isValidHttpUrl, ensureHttps } from './urlUtils.js';

type PartialContext = Partial<Context>;

/**
 * Fetches the content of the article from the given URL using the Ladder service.
 * @param {string} url - The URL of the article to fetch.
 * @param {PartialContext} context - The application context.
 * @returns {Promise<{ title: string; content: string; scriptlessUrl: string | null }>}
 */
export async function fetchArticleContent(
    url: string,
    context: PartialContext
): Promise<{ title: string; content: string; scriptlessUrl: string | null }> {
    console.info(`Fetching article content from URL: ${url}`);

    const ladderServiceUrl = await context.settings?.get('ladder_service_url') ?? '';
    const ladderUsername = await context.settings?.get('ladder_username') ?? '';
    const ladderPassword = await context.settings?.get('ladder_password') ?? '';
    
    if (!ladderServiceUrl || !ladderUsername || !ladderPassword) {
        throw new Error('Ladder service credentials are not properly configured');
    }

    // Ensure the URL is valid and has https://
    if (!isValidHttpUrl(url)) {
        throw new Error('Invalid URL provided');
    }
    url = ensureHttps(url);

    // Decode the URL if it's already encoded, then encode it properly
    const decodedUrl = decodeURIComponent(url);
    const encodedUrl = encodeURIComponent(decodedUrl);

    const ladderUrl = `${ladderServiceUrl}/api/${encodedUrl}`;
    console.debug(`Using Ladder service URL: ${ladderUrl}`);

    try {
        const headers = new Headers({
            'User-Agent': 'Devvit AI Summaries App (https://developers.reddit.com/)',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
            'Authorization': 'Basic ' + Buffer.from(`${ladderUsername}:${ladderPassword}`).toString('base64')
        });

        console.debug(`Authorization header: ${headers.get('Authorization')}`);

        const response = await fetchWithRetry(ladderUrl, {
            method: 'GET',
            headers: headers
        });

        const html = await response.text();
        console.debug('Fetched HTML content successfully.');

        const $ = cheerio.load(html);
        console.debug('Loaded HTML into Cheerio.');

        // Extract title and content as before
        let title = $('meta[property="og:title"]').attr('content') || 
                    $('meta[name="twitter:title"]').attr('content') ||
                    $('title').text() || 
                    'No title found';
        console.debug(`Extracted title: ${title}`);

        // Try to extract content using various selectors
        let content = '';
        const contentSelectors = ['article', '.article-content', '.post-content', 'main', '.main-content'];
        for (const selector of contentSelectors) {
            content = $(selector).text();
            if (content) {
                console.debug(`Extracted content from ${selector} selector.`);
                break;
            }
        }

        // Fallback to body if no content found
        if (!content) {
            content = $('body').text();
            console.debug('Extracted content from <body> tag as fallback.');
        }

        content = content.replace(/\s+/g, ' ').trim();
        console.debug('Cleaned up the extracted content.');

        // Check if content is empty or very short
        if (!content || content.length < 100) {
            console.warn('Extracted content is empty or very short. Possible paywall or JavaScript-dependent content.');
        }

        return {
            title,
            content,
            scriptlessUrl: ladderUrl,
        };
    } catch (error) {
        console.error(`Error fetching article content from Ladder service URL ${ladderUrl}:`, error);
        throw error;
    }
}

/**
 * Retry mechanism with exponential backoff.
 * @param {string} url - The URL to fetch.
 * @param {RequestInit} options - Fetch options.
 * @param {number} retries - Number of retries left.
 * @param {number} backoff - Backoff time in milliseconds.
 * @returns {Promise<Response>}
 */
async function fetchWithRetry(url: string, options: RequestInit, retries: number = CONSTANTS.MAX_RETRIES, backoff: number = 300): Promise<Response> {
    try {
        console.debug(`Attempting to fetch: ${url} | Retries left: ${retries}`);
        
        const fetchPromise = fetch(url, options);
        
        const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Request timed out')), 30000) // 30 seconds timeout
        );
        
        const response = await Promise.race([
            fetchPromise.then(async (res) => {
                if (!res.ok) {
                    throw new Error(`HTTP error! status: ${res.status}`);
                }
                return res;
            }),
            timeoutPromise
        ]) as Response;
        
        return response;
    } catch (error) {
        if (error instanceof TypeError) {
            console.error(`Network error: The request was refused or the network is unavailable. Error: ${error.message}`);
        } else if (error instanceof Error) {
            console.error(`Fetch error: ${error.name} - ${error.message}`);
        } else {
            console.error(`Unknown error occurred during fetch: ${error}`);
        }
        
        if (retries === 0) throw error;
        console.debug(`Waiting for ${backoff}ms before retrying...`);
        await new Promise(resolve => setTimeout(resolve, backoff));
        return fetchWithRetry(url, options, retries - 1, backoff * 2);
    }
}

/**
 * Delays execution for the specified number of milliseconds.
 * @param {number} ms - Milliseconds to delay.
 * @returns {Promise<void>}
 */
function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
