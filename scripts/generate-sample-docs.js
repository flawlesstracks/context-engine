#!/usr/bin/env node
'use strict';

/**
 * Generate sample tax client documents for Acme Consulting LLC demo.
 *
 * Usage:
 *   node scripts/generate-sample-docs.js           # Uses pre-written templates (no LLM)
 *   node scripts/generate-sample-docs.js --llm      # Regenerates via Claude (costs ~$0.05)
 *
 * Output: samples/acme-tax-client/*.txt
 *
 * These files feed through the universal parser extraction pipeline to populate
 * a knowledge graph, then gap analysis scores completeness against the
 * tax_preparation matter template.
 */

const fs = require('fs');
const path = require('path');

const OUTPUT_DIR = path.resolve(__dirname, '..', 'samples', 'acme-tax-client');

const DOCUMENTS = [
  {
    filename: 'acme_articles_of_incorporation.txt',
    description: 'Georgia LLC Articles of Organization for Acme Consulting LLC, formed March 15, 2022. Members: John R. Smith (organizer) and Maria L. Garcia (organizer). Registered agent: Sarah Chen. Principal office: 1847 Peachtree Road NE, Suite 310, Atlanta, GA 30309. Control number 22-047891.',
  },
  {
    filename: 'acme_operating_agreement.txt',
    description: '2-member LLC operating agreement for Acme Consulting LLC. John R. Smith: 60% membership interest, $120,000 initial capital, managing member, SSN ending 4271. Maria L. Garcia: 40% membership interest, $80,000 initial capital, SSN ending 8834. Fiscal year ends December 31. Taxed as partnership (Form 1065). Tax matters partner: John R. Smith.',
  },
  {
    filename: 'acme_ein_letter.txt',
    description: 'IRS CP 575 notice assigning EIN 88-4923156 to Acme Consulting LLC. Entity type: LLC taxed as partnership. State of formation: Georgia. Fiscal year end: December. Must file Form 1065 by 03/15/2026.',
  },
  {
    filename: 'acme_profit_and_loss_2025.txt',
    description: 'Annual P&L for Acme Consulting LLC (EIN 88-4923156), year ended December 31, 2025. Total revenue: $1,812,450. Gross profit: $1,353,750. Operating expenses: $965,900 (includes guaranteed payments: Smith $180K, Garcia $150K; staff salaries $287,400). Net income: $389,950 (Smith 60%: $233,970, Garcia 40%: $155,980). Prepared by Peachtree Bookkeeping Services.',
  },
  {
    filename: 'acme_balance_sheet_2025.txt',
    description: 'Year-end balance sheet for Acme Consulting LLC as of December 31, 2025. Total assets: $763,600 (Chase checking $187,400, savings $250,000, AR $198,600). Total liabilities: $176,800. Members equity: $586,800 (Smith capital: $351,480, Garcia capital: $235,320).',
  },
  {
    filename: 'acme_w9_john_smith.txt',
    description: 'W-9 for John R. Smith / Acme Consulting LLC. SSN ending 4271, EIN 88-4923156. LLC taxed as partnership. Address: 245 Magnolia Lane, Decatur, GA 30030. Phone: (404) 555-0127. Email: john.smith@acmeconsultingllc.com.',
  },
  {
    filename: 'acme_1099_contractor.txt',
    description: '1099-NEC from Acme Consulting LLC to David Park for $87,400 in 2025. Contractor address: 4521 Roswell Road, Apt 8B, Sandy Springs, GA 30342. SSN ending 6543. Services: technology consulting and software development, March-December 2025.',
  },
  {
    filename: 'acme_prior_year_return_2024.txt',
    description: 'Form 1065 summary for tax year 2024. Acme Consulting LLC (EIN 88-4923156). Gross receipts: $1,573,600. Ordinary business income: $304,700. Guaranteed payments: $305,000. Smith share (60%): $182,820. Garcia share (40%): $121,880. Business code: 541610. Prepared by Johnson & Associates Tax Services, PTIN P01234567.',
  },
];

async function generateWithLLM() {
  const Anthropic = require('@anthropic-ai/sdk').default;
  const client = new Anthropic();

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  for (const doc of DOCUMENTS) {
    console.log(`Generating ${doc.filename}...`);
    const message = await client.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 4096,
      messages: [{
        role: 'user',
        content: `Generate a realistic but clearly fictional ${doc.filename.replace(/_/g, ' ').replace('.txt', '')} document as plain text. Include all standard formatting, legal language, and fields you'd find in a real document of this type.\n\nKey details to include:\n${doc.description}\n\nOutput ONLY the document text, no commentary.`
      }],
    });

    const text = message.content[0].text;
    fs.writeFileSync(path.join(OUTPUT_DIR, doc.filename), text);
    console.log(`  Wrote ${text.length} chars`);
  }

  console.log(`\nDone! ${DOCUMENTS.length} files written to ${OUTPUT_DIR}`);
}

function listExisting() {
  if (!fs.existsSync(OUTPUT_DIR)) {
    console.log('No sample documents found. Run with --llm to generate, or they are pre-committed.');
    return;
  }
  const files = fs.readdirSync(OUTPUT_DIR).filter(f => f.endsWith('.txt'));
  console.log(`Found ${files.length} sample documents in ${OUTPUT_DIR}:`);
  for (const f of files) {
    const stat = fs.statSync(path.join(OUTPUT_DIR, f));
    console.log(`  ${f} (${stat.size} bytes)`);
  }
}

if (process.argv.includes('--llm')) {
  generateWithLLM().catch(err => {
    console.error('Generation failed:', err.message);
    process.exit(1);
  });
} else {
  listExisting();
  console.log('\nTip: Run with --llm flag to regenerate documents using Claude.');
}
