import * as cheerio from 'cheerio';
import { Devvit, Context } from '@devvit/public-api';
import { CONSTANTS } from '../config/constants.js';

Devvit.configure({
    http: true,
});

type PartialContext = Partial<Context>;

let cachedToken: string | null = null;
let tokenExpirationTime: number = 0;

/**
 * Fetches a unique token from archive.is to submit URLs for archiving.
 * Utilizes caching to minimize redundant requests.
 * @param {PartialContext} context - The application context.
 * @returns {Promise<string>} - The unique submit token.
 */
export async function getUniqueToken(context: PartialContext): Promise<string> {
    const now = Date.now();

    // Return cached token if still valid
    if (cachedToken && now < tokenExpirationTime) {
        console.debug('Using cached archive.is token.');
        return cachedToken;
    }

    // Attempt to retrieve token from Redis cache
    const storedToken = await context.redis?.get('archive_token');
    const storedExpiration = await context.redis?.get('archive_token_expiration');

    if (storedToken && storedExpiration && now < parseInt(storedExpiration, 10)) {
        console.debug('Using stored archive.is token from Redis.');
        cachedToken = storedToken;
        tokenExpirationTime = parseInt(storedExpiration, 10);
        return cachedToken;
    }

    try {
        console.debug(`Fetching unique token from ${CONSTANTS.ARCHIVE_IS_URL}`);
        const response = await fetchWithRetry(CONSTANTS.ARCHIVE_IS_URL, {
            headers: headers,
        });

        const html = await response.text();
        console.debug('Fetched HTML content successfully.');

        const $ = cheerio.load(html);
        const submitid = $('input[name="submitid"]').val();

        if (submitid) {
            console.debug(`Submitid found: ${submitid}`);
            cachedToken = submitid.toString();
            tokenExpirationTime = now + CONSTANTS.TOKEN_VALIDITY_DURATION;

            await context.redis?.set('archive_token', cachedToken);
            await context.redis?.set('archive_token_expiration', tokenExpirationTime.toString());

            return cachedToken;
        } else {
            console.error('Submitid not found in the response.');
            throw new Error("Submitid not found in the response");
        }
    } catch (error) {
        console.error('Error fetching unique token:', error);
        throw new Error("Failed to obtain unique token");
    }
}

/**
 * Submits a URL to archive.is for archiving.
 * @param {string} url - The URL to archive.
 * @param {string} submitToken - The unique token obtained from getUniqueToken.
 * @param {PartialContext} context - The application context.
 * @returns {Promise<string>} - The archived URL.
 */
export async function submitToArchive(url: string, submitToken: string, context: PartialContext): Promise<string> {
    console.debug(`Submitting URL to archive.is: ${url}`);

    const submitUrl = new URL(`${CONSTANTS.ARCHIVE_IS_URL}submit/`);
    submitUrl.searchParams.append('url', url);
    submitUrl.searchParams.append('submitid', submitToken);

    try {
        const response = await fetchWithRetry(submitUrl.toString(), {
            method: 'GET',
            headers: {
                ...headers,
                'Referer': CONSTANTS.ARCHIVE_IS_URL,
            },
            redirect: 'follow',
        });

        if (response.ok) {
            const locationHeader = response.headers.get('Location');
            if (locationHeader) {
                console.debug(`Archived URL found in Location header: ${locationHeader}`);
                return locationHeader;
            }
        }

        throw new Error(`Failed to submit URL to archive.is: ${response.status}`);
    } catch (error) {
        console.error(`Error submitting to archive.is:`, error);
        throw error;
    }
}

/**
 * Fetches the content of the article from the given URL.
 * @param {string} url - The URL of the article to fetch.
 * @param {string} token - The unique token obtained from archive.is.
 * @param {PartialContext} context - The application context.
 * @returns {Promise<{ title: string; content: string; isArchived: boolean; archiveUrl: string | null }>}
 */
export async function fetchArticleContent(
    url: string,
    token: string,
    context: PartialContext
): Promise<{ title: string; content: string; isArchived: boolean; archiveUrl: string | null }> {
    console.info(`Fetching article content from URL: ${url}`);

    // If the URL is already an archive link, fetch directly from it
    if (url.startsWith(CONSTANTS.ARCHIVE_IS_URL) || url.startsWith(CONSTANTS.ARCHIVE_PH_URL)) {
        console.debug(`URL is already an archive link: ${url}`);
        return await fetchFromArchive(url);
    }

    // Check if the archive already exists
    let archiveUrl = await checkArchiveExists(url);
    let isArchived = false;

    if (!archiveUrl) {
        console.debug(`No archive found. Submitting ${url} to archive.is`);
        try {
            archiveUrl = await submitToArchive(url, token, context);
            isArchived = true;
            console.debug(`Successfully submitted to archive.is. Archive URL: ${archiveUrl}`);
        } catch (error) {
            console.error(`Error submitting to archive.is:`, error);
            return { title: '', content: '', isArchived: false, archiveUrl: null };
        }
    } else {
        isArchived = true;
    }

    console.debug(`Using archived version: ${archiveUrl}`);
    return await fetchFromArchive(archiveUrl);
}

/**
 * Fetches and parses archived content directly from an archive URL.
 * @param {string} archiveUrl - The archived URL to fetch content from.
 * @returns {Promise<{ title: string; content: string; isArchived: boolean; archiveUrl: string }>}
 */
export async function fetchFromArchive(archiveUrl: string): Promise<{ title: string; content: string; isArchived: boolean; archiveUrl: string }> {
    try {
        const response = await fetchWithRetry(archiveUrl, {
            method: 'GET',
            headers: {
                'User-Agent': 'Devvit AI Summaries App (https://developers.reddit.com/)',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
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
      
        const $ = cheerio.load(html);
        console.debug('Loaded HTML into Cheerio.');
      
        const title = $('title').text() || 'No title found';
        console.debug(`Extracted title: ${title}`);
    
        let content = '';
        if ($('article').length) {
            content = $('article').text();
            console.debug('Extracted content from <article> tag.');
        } else {
            content = $('body').text();
            console.debug('Extracted content from <body> tag as fallback.');
        }
    
        content = content.replace(/\s+/g, ' ').trim();
        console.debug('Cleaned up the extracted content.');
    
        return {
            title,
            content,
            isArchived: true,
            archiveUrl,
        };
    } catch (error) {
        console.error(`Error fetching article content from archive URL ${archiveUrl}:`, error);
        throw error;
    }
}

/**
 * Checks if an archive exists for the given URL.
 * @param {string} url - The URL to check.
 * @returns {Promise<string | null>} - The archive URL if exists, otherwise null.
 */
async function checkArchiveExists(url: string): Promise<string | null> {
    const archiveUrl = `${CONSTANTS.ARCHIVE_IS_URL}latest/${encodeURIComponent(url)}`;
    console.debug(`Checking if archive exists for: ${archiveUrl}`);
    try {
        const response = await fetchWithRetry(archiveUrl, {
            method: 'HEAD',
            redirect: 'follow',
            headers: {
                'User-Agent': 'Devvit AI Summaries App (https://developers.reddit.com/)',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
            },
        });
        if (response.ok) {
            console.debug(`Archive found: ${response.url}`);
            return response.url;
        }
    } catch (error) {
        console.error(`Error checking archive: ${error}`);
    }
    return null;
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
        console.warn(`Fetch failed for ${url}. Retries left: ${retries}. Error:`, error);
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

const headers = {
    'User-Agent': 'Devvit AI Summaries App (https://developers.reddit.com/)',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
};
