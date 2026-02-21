const https = require('https');

/**
 * Scrape a LinkedIn profile using the ScrapingDog API.
 * @param {string} linkedinUrl - Full LinkedIn profile URL
 * @returns {Promise<object|null>} Structured profile data, or null on failure
 */
async function scrapeLinkedInProfile(linkedinUrl) {
  const apiKey = process.env.SCRAPINGDOG_API_KEY;
  if (!apiKey) {
    console.error('SCRAPINGDOG_API_KEY is not set in environment variables');
    return null;
  }

  const params = new URLSearchParams({
    api_key: apiKey,
    type: 'profile',
    linkId: linkedinUrl
  });

  const url = `https://api.scrapingdog.com/linkedin?${params.toString()}`;

  return new Promise((resolve) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) {
            console.error(`ScrapingDog API returned status ${res.statusCode}: ${data}`);
            resolve(null);
            return;
          }
          const parsed = JSON.parse(data);
          resolve(parsed);
        } catch (err) {
          console.error('Failed to parse ScrapingDog response:', err.message);
          resolve(null);
        }
      });
    }).on('error', (err) => {
      console.error('ScrapingDog request failed:', err.message);
      resolve(null);
    });
  });
}

module.exports = { scrapeLinkedInProfile };
