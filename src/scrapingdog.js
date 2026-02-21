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

/**
 * Transform ScrapingDog LinkedIn API response into Career Lite schema.
 * Maps ScrapingDog field names to the format expected by linkedInResponseToEntity.
 * @param {object} raw - Raw ScrapingDog profile response
 * @param {string} linkedinUrl - Original LinkedIn URL
 * @returns {object} Career Lite compatible parsed object
 */
function transformScrapingDogProfile(raw, linkedinUrl) {
  if (!raw) return null;

  // ScrapingDog returns various field structures; normalize them
  const firstName = raw.first_name || raw.firstName || '';
  const lastName = raw.last_name || raw.lastName || '';
  const fullName = raw.name || raw.full_name || [firstName, lastName].filter(Boolean).join(' ');

  // Work history: ScrapingDog uses "experience" array
  const experience = (raw.experience || []).map(exp => ({
    company: exp.company || exp.company_name || exp.org || '',
    title: exp.title || exp.position || exp.role || '',
    start_date: exp.start_date || exp.starts_at || exp.from || '',
    end_date: exp.end_date || exp.ends_at || exp.to || '',
    description: exp.description || exp.summary || '',
  }));

  // Education
  const education = (raw.education || []).map(edu => ({
    institution: edu.school || edu.institution || edu.school_name || '',
    degree: edu.degree || edu.degree_name || '',
    field: edu.field || edu.field_of_study || edu.major || '',
    year: edu.end_date || edu.ends_at || edu.graduation_year || '',
  }));

  // Skills
  const skills = raw.skills || [];

  // Current position: first experience entry or explicit fields
  const currentExp = experience.find(e => !e.end_date || e.end_date.toLowerCase() === 'present') || experience[0] || {};
  const currentTitle = raw.title || raw.headline_title || currentExp.title || '';
  const currentCompany = raw.company || raw.company_name || currentExp.company || '';

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
