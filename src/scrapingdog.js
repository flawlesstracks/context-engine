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
 * Normalize ScrapingDog date fields.
 * Handles: string ("Mar 2023"), object ({month, year, day}), or empty.
 */
function normalizeDate(d) {
  if (!d) return '';
  if (typeof d === 'string') return d;
  if (typeof d === 'object') {
    const parts = [];
    if (d.year) parts.push(String(d.year));
    if (d.month) parts.unshift(String(d.month).padStart(2, '0'));
    if (d.day) parts.push(String(d.day).padStart(2, '0'));
    return parts.join('-');
  }
  return String(d);
}

/**
 * Transform ScrapingDog LinkedIn API response into Career Lite schema.
 * Maps ScrapingDog field names to the format expected by linkedInResponseToEntity.
 *
 * ScrapingDog actual field names (from real API responses):
 *   experience[]: company_name, company_image, company_position, starts_at, ends_at, description, duration
 *   education[]: school_name, degree_name, field_of_study, starts_at, ends_at
 *   volunteering[]: company_name, company_position, starts_at, ends_at, company_duration
 *   courses[]: name
 *   projects[]: title, link, duration
 *   recommendations[]: name, summary (text)
 *   description: { description1 (company), description2 (school) }
 *
 * @param {object} raw - Raw ScrapingDog profile response
 * @param {string} linkedinUrl - Original LinkedIn URL
 * @returns {object} Career Lite compatible parsed object
 */
function transformScrapingDogProfile(raw, linkedinUrl) {
  if (!raw) return null;

  console.log('[scrapingdog] Raw response keys:', Object.keys(raw).join(', '));
  console.log('[scrapingdog] experience entries:', (raw.experience || []).length);
  console.log('[scrapingdog] education entries:', (raw.education || []).length);
  console.log('[scrapingdog] volunteering entries:', (raw.volunteering || []).length);
  console.log('[scrapingdog] courses entries:', (raw.courses || []).length);
  console.log('[scrapingdog] projects entries:', (raw.projects || []).length);

  const firstName = raw.first_name || '';
  const lastName = raw.last_name || '';
  const fullName = raw.fullName || raw.full_name || raw.name || [firstName, lastName].filter(Boolean).join(' ');

  // --- Work history ---
  // ScrapingDog uses company_position (not position/title) and starts_at/ends_at as strings
  const experience = (raw.experience || []).map(exp => ({
    company: exp.company_name || exp.company || exp.org || '',
    title: exp.company_position || exp.position || exp.title || exp.role || '',
    start_date: normalizeDate(exp.starts_at || exp.start_date || exp.from),
    end_date: normalizeDate(exp.ends_at || exp.end_date || exp.to),
    description: exp.description || exp.summary || '',
    duration: exp.duration || exp.company_duration || '',
  }));

  // Merge volunteering entries as additional experience (with volunteer prefix)
  const volunteering = (raw.volunteering || []).map(vol => ({
    company: vol.company_name || '',
    title: (vol.company_position || vol.title || '') + ' (Volunteer)',
    start_date: normalizeDate(vol.starts_at || vol.start_date),
    end_date: normalizeDate(vol.ends_at || vol.end_date),
    description: vol.company_duration || '',
    duration: vol.company_duration || '',
  }));

  // Add volunteering to experience if experience is sparse
  const allExperience = [...experience, ...volunteering];

  // --- Education ---
  let education = (raw.education || []).map(edu => ({
    institution: edu.school_name || edu.school || edu.institution || '',
    degree: edu.degree_name || edu.degree || '',
    field: edu.field_of_study || edu.field || edu.major || '',
    year: normalizeDate(edu.ends_at || edu.end_date || edu.graduation_year),
  }));

  // Fallback: if education array is empty, check description.description2 (school reference)
  if (education.length === 0 && raw.description && typeof raw.description === 'object') {
    const desc = raw.description;
    if (desc.description2 && !desc.description2.startsWith('http')) {
      education.push({
        institution: desc.description2,
        degree: '',
        field: '',
        year: '',
      });
    }
  }

  // --- Skills ---
  // Try skills array first, then fall back to courses
  let skills = raw.skills || [];
  if (skills.length > 0 && typeof skills[0] === 'object') {
    skills = skills.map(s => s.name || s.skill || String(s)).filter(Boolean);
  }
  // Supplement with courses (ScrapingDog returns these when skills aren't available)
  if (Array.isArray(raw.courses)) {
    for (const c of raw.courses) {
      const name = c.name || '';
      if (name && !skills.includes(name)) skills.push(name);
    }
  }

  // --- Headline ---
  // ScrapingDog sometimes returns empty headline; construct from about text if needed
  let headline = raw.headline || raw.sub_title || '';

  // --- Current position ---
  // Find first experience with no end_date or "Present"
  const currentExp = allExperience.find(e =>
    !e.end_date || (typeof e.end_date === 'string' && e.end_date.toLowerCase().includes('present'))
  ) || allExperience[0] || {};
  const currentTitle = currentExp.title || '';
  const currentCompany = currentExp.company || '';

  // --- Projects as additional context ---
  const projects = (raw.projects || []).filter(p => p.title).map(p => ({
    name: p.title,
    duration: p.duration || '',
    url: (p.link && !p.link.includes('trk=')) ? p.link : '',
  }));

  const result = {
    name: { full: fullName, preferred: firstName, aliases: [] },
    email: raw.email || '',
    phone: raw.phone || raw.phone_number || '',
    headline,
    location: raw.location || raw.city || '',
    linkedin_url: linkedinUrl,
    summary: raw.about || raw.summary || '',
    current_title: currentTitle,
    current_company: currentCompany,
    work_history: allExperience,
    education,
    skills: Array.isArray(skills) ? skills : [],
    connections: [],
    profile_photo: raw.profile_photo || '',
    projects,
  };

  console.log('[scrapingdog] Transformed: work_history=' + result.work_history.length +
    ', education=' + result.education.length +
    ', skills=' + result.skills.length +
    ', projects=' + (result.projects || []).length);

  return result;
}

module.exports = { scrapeLinkedInProfile, transformScrapingDogProfile };
