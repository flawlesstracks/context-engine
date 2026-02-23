'use strict';

const { BaseConnector } = require('./base-connector');

// ---------------------------------------------------------------------------
// Clio Connector — STUB (MECE-018)
//
// Clio developer approval is pending. This stub registers the provider
// in the connector registry so it appears in GET /api/connectors,
// but all methods throw until the approval clears.
// ---------------------------------------------------------------------------

class ClioConnector extends BaseConnector {
  constructor(graphDir, connectionId) {
    super(graphDir, connectionId);
    this.provider = 'clio';
  }

  async connect() {
    throw new Error('Clio connector pending developer approval. Contact support@clio.com for status.');
  }

  async sync(options, writeEvent) {
    throw new Error('Clio connector pending developer approval.');
  }

  async disconnect() {
    throw new Error('Clio connector pending developer approval.');
  }

  getStatus() {
    return {
      connected: false,
      provider: 'clio',
      message: 'Clio connector pending developer approval',
    };
  }

  async handleWebhook(headers, body) {
    throw new Error('Clio connector pending developer approval.');
  }
}

module.exports = ClioConnector;
