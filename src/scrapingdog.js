const https = require('https');

/**
 * Scrape a LinkedIn profile using the ScrapingDog API.
 * @param {string} linkedinUrl - Full LinkedIn profile URL
 * @returns {Promise<object|null>} Structured profile data, or null on failure
 */
async function scrapeLinkedInProfile(linkedinUrl, retries = 1) {
  const apiKey = process.env.SCRAPINGDOG_API_KEY;
  if (!apiKey) {
    console.error('SCRAPINGDOG_API_KEY is not set in environment variables');
    return null;
  }

  // Extract profile slug from full URL (ScrapingDog expects slug, not full URL)
  const slugMatch = linkedinUrl.match(/linkedin\.com\/in\/([^/?#]+)/i);
  const linkId = slugMatch ? slugMatch[1] : linkedinUrl;

  const params = new URLSearchParams({
    api_key: apiKey,
    type: 'profile',
    linkId: linkId,
    premium: 'true'
  });

  const url = `https://api.scrapingdog.com/linkedin?${params.toString()}`;

  const attempt = () => new Promise((resolve) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) {
            console.error(`ScrapingDog API returned status ${res.statusCode}: ${data}`);
            resolve({ status: res.statusCode, body: data, ok: false });
            return;
          }
          let parsed = JSON.parse(data);
          // ScrapingDog wraps LinkedIn profile responses in an array
          if (Array.isArray(parsed) && parsed.length > 0) parsed = parsed[0];
          resolve({ status: 200, body: parsed, ok: true });
        } catch (err) {
          console.error('Failed to parse ScrapingDog response:', err.message);
          resolve({ status: res.statusCode, body: null, ok: false });
        }
      });
    }).on('error', (err) => {
      console.error('ScrapingDog request failed:', err.message);
      resolve({ status: 0, body: null, ok: false });
    });
  });

  // First attempt
  let result = await attempt();
  if (result.ok) return result.body;

  // ScrapingDog returns "try again after 2-3 minutes" for first-time profiles
  // Retry once after a delay if we get that specific message
  if (retries > 0 && typeof result.body === 'string' && result.body.includes('try again')) {
    console.log('[scrapingdog] Profile being scraped for first time, retrying in 10s...');
    await new Promise(r => setTimeout(r, 10000));
    result = await attempt();
    if (result.ok) return result.body;
  }

  return null;
}

/**
 * Transform ScrapingDog LinkedIn API response into Career Lite schema.
 * Maps ScrapingDog field names to the format expected by linkedInResponseToEntity.
 * @param {object} raw - Raw ScrapingDog profile response
 * @param {string} linkedinUrl - Original LinkedIn URL
 * @returns {object} Career Lite compatible parsed object
 */
function transformScrapingDogProfile(raw, linkedinUrl) {
  if (!raw) return null;

  // ScrapingDog field names: fullName, first_name, last_name, headline, location, about,
  // experience[].position, experience[].company_name, experience[].starts_at, experience[].ends_at,
  // education[].school_name, education[].degree_name, education[].field_of_study, education[].starts_at, education[].ends_at
  const firstName = raw.first_name || '';
  const lastName = raw.last_name || '';
  const fullName = raw.fullName || raw.full_name || raw.name || [firstName, lastName].filter(Boolean).join(' ');

  // Work history
  const experience = (raw.experience || []).map(exp => ({
    company: exp.company_name || exp.company || exp.org || '',
    title: exp.position || exp.title || exp.role || '',
    start_date: exp.starts_at || exp.start_date || exp.from || '',
    end_date: exp.ends_at || exp.end_date || exp.to || '',
    description: exp.description || exp.summary || '',
  }));

  // Education
  const education = (raw.education || []).map(edu => ({
    institution: edu.school_name || edu.school || edu.institution || '',
    degree: edu.degree_name || edu.degree || '',
    field: edu.field_of_study || edu.field || edu.major || '',
    year: edu.ends_at || edu.end_date || edu.graduation_year || '',
  }));

  // Skills — ScrapingDog may return strings or objects
  let skills = raw.skills || [];
  if (skills.length > 0 && typeof skills[0] === 'object') {
    skills = skills.map(s => s.name || s.skill || String(s)).filter(Boolean);
  }

  // Current position: first experience with no end_date or "Present", or just first entry
  const currentExp = experience.find(e => !e.end_date || e.end_date.toLowerCase() === 'present') || experience[0] || {};
  const currentTitle = currentExp.title || '';
  const currentCompany = currentExp.company || '';

  return {
    name: { full: fullName, preferred: firstName, aliases: [] },
    email: raw.email || '',
    phone: raw.phone || raw.phone_number || '',
    headline: raw.headline || raw.sub_title || '',
    location: raw.location || raw.city || '',
    linkedin_url: linkedinUrl,
    summary: raw.about || raw.summary || raw.description || '',
    current_title: currentTitle,
    current_company: currentCompany,
    work_history: experience,
    education,
    skills: Array.isArray(skills) ? skills : [],
    connections: [],
  };
}

module.exports = { scrapeLinkedInProfile, transformScrapingDogProfile };
