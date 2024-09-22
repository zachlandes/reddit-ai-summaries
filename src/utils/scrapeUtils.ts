import * as cheerio from 'cheerio';
import { Devvit, Context } from '@devvit/public-api';
import { CONSTANTS } from '../config/constants.js';

Devvit.configure({
    http: true,
});

export type PartialContext = Partial<Context>;

let cachedToken: string | null = null;
let tokenExpirationTime: number = 0;

async function checkArchiveExists(url: string): Promise<string | null> {
    const archiveUrl = `${CONSTANTS.ARCHIVE_IS_URL}latest/${encodeURIComponent(url)}`;
    console.debug(`Checking if archive exists for: ${archiveUrl}`);
    try {
        const response = await fetch(archiveUrl, {
            method: 'HEAD',
            redirect: 'follow',
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

export async function getUniqueToken(context: PartialContext): Promise<string> {
    const now = Date.now();
    if (cachedToken && now < tokenExpirationTime) {
        return cachedToken;
    }

    const storedToken = await context.redis?.get('archive_token');
    const storedExpiration = await context.redis?.get('archive_token_expiration');

    if (storedToken && storedExpiration && now < parseInt(storedExpiration)) {
        cachedToken = storedToken;
        tokenExpirationTime = parseInt(storedExpiration);
        return cachedToken;
    }

    try {
        const response = await fetch(CONSTANTS.ARCHIVE_IS_URL);
        const html = await response.text();
        
        const submitidMatch = html.match(/name="submitid"\s+value="([^"]+)"/);
        if (submitidMatch && submitidMatch[1]) {
            cachedToken = submitidMatch[1];
            tokenExpirationTime = now + CONSTANTS.TOKEN_VALIDITY_DURATION;
            
            await context.redis?.set('archive_token', cachedToken);
            await context.redis?.set('archive_token_expiration', tokenExpirationTime.toString());
            
            return cachedToken;
        }
    } catch (error) {
        console.error('Error fetching unique token from archive.is:', error);
        throw new Error("Failed to obtain unique token");
    }

    throw new Error("Failed to obtain unique token");
}

export async function submitToArchive(url: string, submitToken: string): Promise<string> {
    console.debug(`Submitting URL to archive.is: ${url}`);
    
    const formData = new URLSearchParams();
    formData.append('url', url);
    formData.append('anyway', '1');
    formData.append('submitid', submitToken);

    try {
        const response = await fetch(`${CONSTANTS.ARCHIVE_IS_URL}submit/`, {
            method: 'POST',
            body: formData,
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            redirect: 'follow',
        });

        if (response.ok) {
            const location = response.headers.get('Refresh');
            if (location) {
                const match = location.match(/url=(.+)$/);
                if (match && match[1]) {
                    return match[1];
                }
            }
            
            const html = await response.text();
            const archivedUrlMatch = html.match(/<meta property="og:url" content="([^"]+)"/);
            if (archivedUrlMatch && archivedUrlMatch[1]) {
                return archivedUrlMatch[1];
            }
        }

        throw new Error(`Failed to submit URL to archive.is: ${response.status}`);
    } catch (error) {
        console.error(`Error submitting to archive.is:`, error);
        throw error;
    }
}

export async function fetchArticleContent(
    url: string,
    submitToken: string,
    context: PartialContext
): Promise<{ title: string; content: string; isArchived: boolean; archiveUrl: string | null }> {
    console.info(`Fetching article content from URL: ${url}`);
    
    if (url.startsWith(CONSTANTS.ARCHIVE_IS_URL) || url.startsWith(CONSTANTS.ARCHIVE_PH_URL)) {
        console.debug(`URL is already an archive.is link: ${url}`);
        return await fetchFromArchive(url);
    }
    
    let archiveUrl = await checkArchiveExists(url);
    let isArchived = false;

    if (!archiveUrl) {
        console.debug(`No archive found. Submitting ${url} to archive.is`);
        try {
            archiveUrl = await submitToArchive(url, submitToken);
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

async function fetchFromArchive(archiveUrl: string): Promise<{ title: string; content: string; isArchived: boolean; archiveUrl: string }> {
    try {
        const response = await fetch(archiveUrl, {
            method: 'GET',
            headers: {
                'User-Agent': 'Devvit AI Summaries App (https://developers.reddit.com/)', // TODO: Update this link with app's directory page
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
